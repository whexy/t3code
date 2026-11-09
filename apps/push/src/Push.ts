import type {
  RelayAgentActivitySnapshotResponse,
  RelayAgentActivityState,
  RelayDeliveryResult,
  RelayDeviceRegistrationRequest,
  RelayLiveActivityRegistrationRequest,
  RelayPublishResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

import { makeAggregateState } from "../../../infra/relay/src/agentActivity/agentActivityAggregate.ts";
import * as Apns from "../../../infra/relay/src/agentActivity/ApnsClient.ts";
import type { ApnsCredentials } from "../../../infra/relay/src/Config.ts";
import {
  chooseDelivery,
  credentialsForTarget,
  hasCard,
  isPermanentApnsTokenFailure,
  notificationForPublish,
  type ChosenDelivery,
  type TargetRow,
} from "./cardDelivery.ts";
import * as PushStore from "./PushStore.ts";

export interface ApnsSettings {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  /** For devices whose registration names no bundle id. */
  readonly defaultBundleId: string | null;
}

export class Push extends Context.Service<
  Push,
  {
    /** Resolves once a recorded delivery to every device has read the published row. */
    readonly publish: (input: {
      readonly environmentId: string;
      readonly threadId: string;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<RelayPublishResponse, PushStore.PushStoreError>;
    readonly registerDevice: (
      registration: RelayDeviceRegistrationRequest,
    ) => Effect.Effect<void, PushStore.PushStoreError>;
    readonly registerLiveActivity: (
      registration: RelayLiveActivityRegistrationRequest,
    ) => Effect.Effect<void, PushStore.PushStoreError>;
    readonly unregisterDevice: (deviceId: string) => Effect.Effect<void, PushStore.PushStoreError>;
    readonly snapshot: Effect.Effect<RelayAgentActivitySnapshotResponse, PushStore.PushStoreError>;
    /** Ends every live card with nothing left to show, as AgentActivityPublisher.endIdleLiveActivities. */
    readonly sweepIdle: Effect.Effect<void, PushStore.PushStoreError>;
  }
>()("@t3tools/push/Push") {}

// Upstream's cron prunes finished rows after 30 minutes, twice their display TTL.
const TERMINAL_ROW_RETENTION_MS = 30 * 60 * 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

interface Waiter {
  readonly seq: number;
  readonly done: Deferred.Deferred<RelayDeliveryResult | null>;
}

interface Published {
  readonly key: string;
  readonly state: RelayAgentActivityState | null;
}

interface Owed {
  readonly seq: number;
  /** Null for a deleted thread, so a retried earlier state cannot come back. */
  readonly state: RelayAgentActivityState | null;
}

/**
 * One device's deliveries. `requested` counts the deliveries asked for and
 * `completed` the highest one a finished delivery covered, so a request waits
 * for the first delivery that starts after it was stored.
 */
interface DeviceQueue {
  requested: number;
  completed: number;
  /**
   * Each published thread's latest state until a delivery decides its notification. Coalesced
   * publishes of one thread notify once, for the latest, as the card would show.
   */
  owed: Map<string, Owed>;
  running: boolean;
  waiters: Array<Waiter>;
}

interface Enqueued {
  readonly deviceId: string;
  readonly done: Deferred.Deferred<RelayDeliveryResult | null>;
  readonly start: boolean;
}

interface Prepared {
  readonly target: number;
  /** The phone has no card, so this delivery's publishes owe notifications. */
  readonly notifies: boolean;
  readonly missingBundleId?: true;
  /** The publish this send notifies about, taken from `owed`. */
  readonly notified?: {
    readonly key: string;
    readonly owed: Owed & { readonly state: RelayAgentActivityState };
  };
  readonly send: {
    readonly chosen: ChosenDelivery;
    readonly credentials: ApnsCredentials;
    /** The alert baseline before this send's write-ahead record. */
    readonly previousSent: string | null;
    /** The phases this send marked as rung. */
    readonly marks: ReadonlyArray<PushStore.PhaseMark>;
  } | null;
}

type Attempt =
  | { readonly _tag: "done"; readonly target: number; readonly result: RelayDeliveryResult | null }
  | { readonly _tag: "retry" }
  | { readonly _tag: "again"; readonly result: RelayDeliveryResult | null };

const deliveryResult = (
  deviceId: string,
  kind: ChosenDelivery["kind"],
  result: Apns.ApnsDeliveryResult,
): RelayDeliveryResult => ({
  deviceId,
  kind,
  ok: result.ok,
  apnsStatus: result.status === 0 ? null : result.status,
  apnsReason: result.reason ?? null,
  apnsId: result.apnsId,
});

const make = Effect.fn("Push.make")(function* (settings: ApnsSettings) {
  const store = yield* PushStore.PushStore;
  const apns = yield* Apns.ApnsClient;
  const workers = yield* FiberSet.make();
  const queues = new Map<string, DeviceQueue>();
  const baseCredentials = {
    teamId: settings.teamId,
    keyId: settings.keyId,
    privateKey: settings.privateKey,
    bundleId: settings.defaultBundleId,
    environment: "production" as const,
  };

  const storeStep = <A>(operation: string, run: () => A) =>
    Effect.try({
      try: run,
      catch: (cause) => new PushStore.PushStoreError({ operation, cause }),
    });

  // Synchronous, so a caller can store a row and queue its delivery in one step.
  const enqueue = (deviceId: string, published: Published | null): Enqueued => {
    let queue = queues.get(deviceId);
    if (queue === undefined) {
      queue = {
        requested: 0,
        completed: 0,
        owed: new Map(),
        running: false,
        waiters: [],
      };
      queues.set(deviceId, queue);
    }
    queue.requested += 1;
    if (published !== null) {
      queue.owed.delete(published.key);
      queue.owed.set(published.key, { seq: queue.requested, state: published.state });
    }
    const done = Deferred.makeUnsafe<RelayDeliveryResult | null>();
    queue.waiters.push({ seq: queue.requested, done });
    const start = !queue.running;
    queue.running = true;
    return { deviceId, done, start };
  };

  const complete = (queue: DeviceQueue, target: number, result: RelayDeliveryResult | null) => {
    queue.completed = target;
    for (const [key, owed] of queue.owed) if (owed.seq <= target) queue.owed.delete(key);
    const answered = queue.waiters.filter((waiter) => waiter.seq <= target);
    // Resuming a waiter can run its fiber at once, and that fiber can queue another delivery.
    queue.waiters = queue.waiters.filter((waiter) => waiter.seq > target);
    for (const waiter of answered) Deferred.doneUnsafe(waiter.done, Effect.succeed(result));
  };

  // Takes owed publishes in order until one rings; a publish that rings nothing owes nothing.
  // A host republishes a phase on a title change or a retry; the phone hears of each phase once.
  const takeNotification = (queue: DeviceQueue, device: TargetRow, nowMs: number) => {
    for (const [key, owed] of queue.owed) {
      queue.owed.delete(key);
      const state = owed.state;
      if (state === null) continue;
      const thread = {
        deviceId: device.device_id,
        environmentId: state.environmentId,
        threadId: state.threadId,
      };
      if (store.notifiedPhase(thread) === state.phase) continue;
      const chosen = notificationForPublish({ target: device, state, nowMs });
      if (chosen === null) continue;
      const mark = { ...thread, phase: state.phase };
      store.markNotified(mark);
      return { chosen, mark, notified: { key, owed: { ...owed, state } } };
    }
    return null;
  };

  // Reads every row, chooses the update and persists it before the send, with
  // nothing interleaved: a publish stored after this waits for the next delivery.
  const prepare = (deviceId: string, queue: DeviceQueue, nowMs: number): Prepared => {
    const target = queue.requested;
    const device = store.getTarget(deviceId);
    if (device === null || device.platform !== "ios") {
      return { target, notifies: false, send: null };
    }
    const notifies = !hasCard(device);
    const credentials = credentialsForTarget(baseCredentials, device);
    if (credentials === null) {
      return { target, notifies, send: null, missingBundleId: true };
    }
    const chosen = chooseDelivery({
      target: device,
      aggregate: makeAggregateState({
        activeStates: store.listRows(),
        terminalState: null,
        nowMs,
      }),
      nowMs,
    });
    if (chosen !== null) {
      // A card alert rings its threads' phases as a notification would (NotifyOncePerPhase).
      const marks = (chosen.kind === "live_activity_update" ? chosen.alerted : [])
        .map((row) => ({
          deviceId,
          environmentId: row.environmentId,
          threadId: row.threadId,
          phase: row.phase,
        }))
        .filter((mark) => store.notifiedPhase(mark) !== mark.phase);
      const previousSent = store.beginSend({
        deviceId,
        token: chosen.token,
        kind: chosen.kind,
        aggregate: chosen.aggregate,
        marks,
      });
      return { target, notifies, send: { chosen, credentials, previousSent, marks } };
    }
    const notification = notifies ? takeNotification(queue, device, nowMs) : null;
    return notification === null
      ? { target, notifies, send: null }
      : {
          target,
          notifies,
          notified: notification.notified,
          send: {
            chosen: notification.chosen,
            credentials,
            previousSent: null,
            marks: [notification.mark],
          },
        };
  };

  const send = (chosen: ChosenDelivery, credentials: ApnsCredentials, now: DateTime.Utc) => {
    const nowEpochSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const base = { token: chosen.token, nowEpochSeconds, nowIso: DateTime.formatIso(now) };
    switch (chosen.kind) {
      case "push_notification":
        return apns.sendPushNotificationRequest({
          credentials,
          request: apns.makePushNotificationRequest({
            token: chosen.token,
            notification: chosen.notification,
          }),
          issuedAtUnixSeconds: nowEpochSeconds,
        });
      case "live_activity_update":
        return apns.sendLiveActivityRequest({
          credentials,
          request: apns.makeLiveActivityRequest({
            ...base,
            event: "update",
            state: chosen.aggregate,
            alert: chosen.alert,
          }),
          issuedAtUnixSeconds: nowEpochSeconds,
        });
      case "live_activity_end":
        return apns.sendLiveActivityRequest({
          credentials,
          request: apns.makeLiveActivityRequest({ ...base, event: "end", state: null }),
          issuedAtUnixSeconds: nowEpochSeconds,
        });
    }
  };

  const deliver = Effect.fn("Push.deliver")(function* (deviceId: string, queue: DeviceQueue) {
    yield* Effect.annotateCurrentSpan({ "push.device_id": deviceId });
    const now = yield* DateTime.now;
    const prepared = yield* storeStep("prepare-delivery", () =>
      prepare(deviceId, queue, now.epochMilliseconds),
    );
    if (prepared.missingBundleId) {
      yield* Effect.logWarning("phone has no bundle id and APNS_DEFAULT_BUNDLE_ID is unset", {
        deviceId,
      });
    }
    if (prepared.send === null) {
      return { _tag: "done", target: prepared.target, result: null } satisfies Attempt;
    }
    const { chosen, credentials, previousSent, marks } = prepared.send;
    const retry = (): Attempt => {
      const notified = prepared.notified;
      // A newer publish of the same thread, stored meanwhile, replaces it.
      if (notified !== undefined)
        queue.owed = new Map([[notified.key, notified.owed], ...queue.owed]);
      return { _tag: "retry" };
    };
    // Without a card, the publishes this delivery covered may owe more notifications.
    const finish = (result: RelayDeliveryResult): Attempt =>
      prepared.notifies && queue.owed.size > 0
        ? { _tag: "again", result }
        : { _tag: "done", target: prepared.target, result };
    const outcome = yield* send(chosen, credentials, now).pipe(
      Effect.map((result) => ({ _tag: "answered", result }) as const),
      Effect.catchTags({
        // Nothing left the process.
        ApnsJwtEncodingError: (error) => Effect.succeed({ _tag: "unsent", error } as const),
        ApnsJwtSigningError: (error) => Effect.succeed({ _tag: "unsent", error } as const),
        // A timeout or a broken connection: APNs may have accepted it.
        ApnsHttpRequestError: (error) => Effect.succeed({ _tag: "unknown", error } as const),
      }),
    );
    const deliveredAt = DateTime.formatIso(yield* DateTime.now);
    // Nothing reached the phone: undo the write-ahead record so the retry may alert. An end
    // stays pending (EndIsFinal).
    const undoWriteAhead = () =>
      store.undoSend({
        deviceId,
        card:
          chosen.kind === "push_notification"
            ? null
            : { token: chosen.token, sentAggregateJson: previousSent },
        marks,
      });

    if (outcome._tag === "unknown") {
      yield* Effect.logWarning("APNs send outcome unknown; retrying without its alert", {
        deviceId,
        kind: chosen.kind,
        stage: outcome.error.stage,
      });
      // An alert push is the alert itself: resending it could ring twice.
      if (chosen.kind === "push_notification") {
        return finish({
          deviceId,
          kind: chosen.kind,
          ok: false,
          apnsStatus: null,
          apnsReason: outcome.error.message,
          apnsId: null,
        });
      }
      return retry();
    }
    if (outcome._tag === "unsent") {
      yield* Effect.logError("APNs provider token failed", { deviceId, error: outcome.error._tag });
      yield* storeStep("undo-write-ahead", undoWriteAhead);
      return retry();
    }
    const result = outcome.result;
    if (result.ok) {
      if (chosen.kind !== "push_notification") {
        yield* storeStep("record-delivery", () =>
          store.recordDelivery({
            deviceId,
            token: chosen.token,
            kind: chosen.kind,
            aggregate: chosen.aggregate,
            deliveredAt,
          }),
        );
      }
      return finish(deliveryResult(deviceId, chosen.kind, result));
    }
    yield* Effect.logWarning("APNs refused a delivery", {
      deviceId,
      kind: chosen.kind,
      status: result.status,
      reason: result.reason ?? null,
    });
    if (isPermanentApnsTokenFailure(result)) {
      yield* storeStep("invalidate-token", () => {
        undoWriteAhead();
        store.invalidateToken({
          deviceId,
          token: chosen.token,
          kind: chosen.kind,
          invalidatedAt: deliveredAt,
        });
      });
      if (chosen.kind === "push_notification") {
        return finish(deliveryResult(deviceId, chosen.kind, result));
      }
      // Without the card, the same delivery may still owe a push notification.
      return { _tag: "again", result: null } satisfies Attempt;
    }
    yield* storeStep("undo-write-ahead", undoWriteAhead);
    return retry();
  });

  // Runs for as long as the device has deliveries owed; untraced because deliver spans each attempt.
  const drain = Effect.fnUntraced(function* (deviceId: string) {
    const queue = queues.get(deviceId);
    if (queue === undefined) return;
    let failures = 0;
    // An attempt that sent and left notifications owed answers with the next one's result.
    let sent: RelayDeliveryResult | null = null;
    while (queue.completed < queue.requested) {
      const attempt: Attempt = yield* deliver(deviceId, queue).pipe(
        Effect.catchTags({
          PushStoreError: (error) =>
            Effect.logError("t3-push delivery failed; retrying", {
              deviceId,
              operation: error.operation,
            }).pipe(Effect.as({ _tag: "retry" } as const)),
        }),
      );
      if (attempt._tag === "done") {
        failures = 0;
        complete(queue, attempt.target, attempt.result ?? sent);
        sent = null;
      } else if (attempt._tag === "again") {
        sent = attempt.result ?? sent;
      } else {
        yield* Effect.sleep(Math.min(1_000 * 2 ** failures, MAX_RETRY_DELAY_MS));
        failures += 1;
      }
    }
    queue.running = false;
  });

  const startWorkers = (enqueued: ReadonlyArray<Enqueued>) =>
    Effect.forEach(
      enqueued.filter((entry) => entry.start),
      (entry) => FiberSet.run(workers, drain(entry.deviceId)),
      { discard: true },
    );

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // A switch or send stored just before a crash has nothing queued after the restart, and the
  // phone does not repeat a registration that succeeded: replay every device once.
  yield* storeStep("startup-replay", () =>
    store.listTargets().map((target) => enqueue(target.device_id, null)),
  ).pipe(Effect.flatMap(startWorkers));

  return Push.of({
    publish: Effect.fn("Push.publish")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "push.environment_id": input.environmentId,
        "push.thread_id": input.threadId,
        "push.phase": input.state?.phase ?? "deleted",
      });
      const enqueued = yield* storeStep("publish", () => {
        if (input.state === null) store.deleteRow(input);
        else store.upsertRow(input.state);
        const published = {
          key: JSON.stringify([input.environmentId, input.threadId]),
          state: input.state,
        };
        return store.listTargets().map((target) => enqueue(target.device_id, published));
      });
      yield* startWorkers(enqueued);
      const results = yield* Effect.forEach(enqueued, (entry) => Deferred.await(entry.done));
      return {
        ok: true,
        deliveries: results.filter((result): result is RelayDeliveryResult => result !== null),
      };
    }),
    registerDevice: Effect.fn("Push.registerDevice")(function* (registration) {
      const now = yield* nowIso;
      const enqueued = yield* storeStep("register-device", () => {
        store.registerDevice(registration, now);
        return [enqueue(registration.deviceId, null)];
      });
      yield* startWorkers(enqueued);
    }),
    registerLiveActivity: Effect.fn("Push.registerLiveActivity")(function* (registration) {
      const now = yield* nowIso;
      const enqueued = yield* storeStep("register-live-activity", () => {
        store.registerLiveActivity(registration, now);
        return [enqueue(registration.deviceId, null)];
      });
      yield* startWorkers(enqueued);
    }),
    unregisterDevice: Effect.fn("Push.unregisterDevice")(function* (deviceId) {
      yield* storeStep("unregister-device", () => store.unregisterDevice(deviceId));
    }),
    snapshot: Effect.gen(function* () {
      const now = yield* DateTime.now;
      const activeStates = yield* storeStep("snapshot", () => store.listRows());
      return {
        aggregate: makeAggregateState({
          activeStates,
          terminalState: null,
          nowMs: now.epochMilliseconds,
        }),
      };
    }).pipe(Effect.withSpan("Push.snapshot")),
    sweepIdle: Effect.gen(function* () {
      const now = yield* DateTime.now;
      const enqueued = yield* storeStep("sweep-idle", () => {
        store.pruneTerminalRows(
          DateTime.formatIso(DateTime.subtract(now, { milliseconds: TERMINAL_ROW_RETENTION_MS })),
        );
        const aggregate = makeAggregateState({
          activeStates: store.listRows(),
          terminalState: null,
          nowMs: now.epochMilliseconds,
        });
        if (aggregate !== null) return [];
        return store
          .listTargets()
          .filter((target) => target.activity_push_token !== null)
          .map((target) => enqueue(target.device_id, null));
      });
      yield* startWorkers(enqueued);
    }).pipe(Effect.withSpan("Push.sweepIdle")),
  });
});

export const layer = (settings: ApnsSettings) => Layer.effect(Push, make(settings));

/** The idle sweep, every minute, like the relay's cron. */
export const sweepLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const push = yield* Push;
    yield* Effect.sleep("1 minute").pipe(
      Effect.andThen(push.sweepIdle),
      Effect.catchTags({
        PushStoreError: (error) =>
          Effect.logError("idle sweep failed", { operation: error.operation }),
      }),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
