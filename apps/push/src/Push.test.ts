import { describe, expect, it } from "@effect/vitest";
import {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  type RelayAgentAwarenessPhase,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as ApnsClient from "../../../infra/relay/src/agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "../../../infra/relay/src/agentActivity/ApnsProviderTokens.ts";
import * as Push from "./Push.ts";
import * as PushStore from "./PushStore.ts";

type Reply =
  | { readonly _tag: "status"; readonly status: number; readonly reason?: string }
  /** Never answers: the client's 10 second timeout ends the request. */
  | { readonly _tag: "hang" }
  /** Answers 200 once the test opens the gate. */
  | { readonly _tag: "gate"; readonly gate: Deferred.Deferred<void> };

const ApnsPayload = Schema.Struct({
  aps: Schema.Struct({
    event: Schema.optional(Schema.String),
    alert: Schema.optional(Schema.Struct({ title: Schema.String, body: Schema.String })),
    "content-state": Schema.optional(
      Schema.Struct({ props: Schema.fromJsonString(RelayAgentActivityAggregateState) }),
    ),
  }),
});
const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(ApnsPayload));

/** What one APNs request asked the phone to do. */
interface Sent {
  readonly pushType: string | undefined;
  readonly event: string | null;
  readonly alert: string | null;
  readonly rows: ReadonlyArray<string>;
}

/** Stands in for api.push.apple.com: records each request and answers from `script`. */
const fakeApns = Effect.gen(function* () {
  const sent = yield* Queue.unbounded<Sent>();
  const script: Array<Reply> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      const { aps } = decodePayload(new TextDecoder().decode(body));
      yield* Queue.offer(sent, {
        pushType: request.headers["apns-push-type"],
        event: aps.event ?? null,
        alert: aps.alert?.title ?? null,
        rows: (aps["content-state"]?.props.activities ?? []).map(
          (row) => `${row.threadId}:${row.phase}`,
        ),
      });
      const reply = script.shift() ?? { _tag: "status", status: 200 };
      if (reply._tag === "hang") return yield* Effect.never;
      if (reply._tag === "gate") yield* Deferred.await(reply.gate);
      const status = reply._tag === "status" ? reply.status : 200;
      const reason = reply._tag === "status" ? reply.reason : undefined;
      return HttpClientResponse.fromWeb(
        request,
        new Response(reason === undefined ? "" : JSON.stringify({ reason }), {
          status,
          headers: { "apns-id": "apns-id" },
        }),
      );
    }),
  );
  return { sent, script, client: Layer.succeed(HttpClient.HttpClient, client) };
});

const providerTokens = Layer.succeed(
  ApnsProviderTokens.ApnsProviderTokens,
  ApnsProviderTokens.ApnsProviderTokens.of({ getJwt: () => Effect.succeed("provider-jwt") }),
);

const settings: Push.ApnsSettings = {
  teamId: "TEAM",
  keyId: "KEY",
  privateKey: Redacted.make("unused: provider tokens are faked"),
  defaultBundleId: "codes.t3.test",
};

/** One t3-push process over `store`; closing `scope` is the process dying. */
const startPush = (
  store: Context.Context<PushStore.PushStore>,
  client: Layer.Layer<HttpClient.HttpClient>,
  scope: Scope.Scope,
  options: { readonly sweep?: boolean } = {},
) =>
  Layer.buildWithScope(
    (options.sweep
      ? Layer.provideMerge(Push.sweepLayer, Push.layer(settings))
      : Push.layer(settings)
    ).pipe(
      Layer.provide(ApnsClient.layer),
      Layer.provide(Layer.mergeAll(providerTokens, client)),
      Layer.provide(Layer.succeedContext(store)),
    ),
    scope,
  ).pipe(Effect.map(Context.get(Push.Push)));

const setup = (options: { readonly sweep?: boolean } = {}) =>
  Effect.gen(function* () {
    const apns = yield* fakeApns;
    const store = yield* Layer.build(PushStore.layer(":memory:"));
    const push = yield* startPush(store, apns.client, yield* Effect.scope, options);
    return { apns, store, push };
  });

const preferences = {
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

const registerPhone = (push: Push.Push["Service"], options: { readonly card: boolean }) =>
  Effect.gen(function* () {
    yield* push.registerDevice({
      deviceId: "phone",
      label: "iPhone",
      platform: "ios",
      iosMajorVersion: 18,
      apsEnvironment: "sandbox",
      pushToken: "push-token",
      preferences,
    });
    if (options.card) {
      yield* push.registerLiveActivity({ deviceId: "phone", activityPushToken: "activity-token" });
    }
  });

const decodeState = Schema.decodeUnknownSync(RelayAgentActivityState);

const publish = (push: Push.Push["Service"], host: string, phase: RelayAgentAwarenessPhase) =>
  Effect.gen(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    return yield* push.publish({
      environmentId: host,
      threadId: "thread",
      state: decodeState({
        environmentId: host,
        threadId: "thread",
        projectTitle: "Project",
        threadTitle: `Thread on ${host}`,
        phase,
        headline: phase,
        modelTitle: "Model",
        updatedAt,
        deepLink: "/threads/thread",
      }),
    });
  });

/** A host request in flight: started now, so its row is stored before this returns. */
const startPublish = (push: Push.Push["Service"], host: string, phase: RelayAgentAwarenessPhase) =>
  publish(push, host, phase).pipe(Effect.forkChild({ startImmediately: true }));

const isPending = (fiber: Fiber.Fiber<unknown, unknown>) => fiber.pollUnsafe() === undefined;

/**
 * A recorded card showing h1 running; then APNs accepts h1's move to `phase`
 * and the process dies before recording it. Returns the restarted process.
 */
const crashAfterApnsAccepts = (phase: RelayAgentAwarenessPhase) =>
  Effect.gen(function* () {
    const apns = yield* fakeApns;
    const store = yield* Layer.build(PushStore.layer(":memory:"));
    const doomed = yield* Scope.make();
    const before = yield* startPush(store, apns.client, doomed);
    yield* registerPhone(before, { card: true });
    yield* publish(before, "h1", "running");
    yield* Queue.take(apns.sent);
    apns.script.push({ _tag: "hang" });
    const lost = yield* startPublish(before, "h1", phase);
    expect((yield* Queue.take(apns.sent)).alert).toBe("Thread on h1");
    yield* Scope.close(doomed, Exit.void);
    yield* Fiber.interrupt(lost);
    return { apns, after: yield* startPush(store, apns.client, yield* Effect.scope) };
  });

describe("t3-push deliveries", () => {
  it.effect("sends one delivery at a time and coalesces publishes that arrive meanwhile", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      apns.script.push({ _tag: "gate", gate: first }, { _tag: "gate", gate: second });

      const h1Runs = yield* startPublish(push, "h1", "running");
      expect((yield* Queue.take(apns.sent)).rows).toEqual(["thread:running"]);
      const h2Runs = yield* startPublish(push, "h2", "running");
      const h1Asks = yield* startPublish(push, "h1", "waiting_for_approval");
      expect(isPending(h1Runs)).toBe(true);

      yield* Deferred.succeed(first, undefined);
      const coalesced = yield* Queue.take(apns.sent);
      expect(new Set(coalesced.rows)).toEqual(
        new Set(["thread:waiting_for_approval", "thread:running"]),
      );
      expect(coalesced.rows).toHaveLength(2);
      expect(coalesced.alert).toBe("Thread on h1");
      expect((yield* Fiber.join(h1Runs)).deliveries).toHaveLength(1);
      // Their rows were stored after the first delivery read the rows.
      expect(isPending(h2Runs)).toBe(true);
      expect(isPending(h1Asks)).toBe(true);

      yield* Deferred.succeed(second, undefined);
      expect((yield* Fiber.join(h2Runs)).deliveries).toHaveLength(1);
      expect((yield* Fiber.join(h1Asks)).deliveries).toHaveLength(1);
      expect(yield* Queue.size(apns.sent)).toBe(0);
    }),
  );

  it.effect("answers a host's retry only with a delivery that read the retry's row", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      yield* publish(push, "h1", "running");
      yield* Queue.take(apns.sent);
      const gate = yield* Deferred.make<void>();
      apns.script.push({ _tag: "gate", gate });

      const timedOut = yield* startPublish(push, "h1", "waiting_for_approval");
      yield* Queue.take(apns.sent);
      // The host gives up after 10 seconds and publishes the same state again.
      yield* Fiber.interrupt(timedOut);
      const retried = yield* startPublish(push, "h1", "waiting_for_approval");
      yield* Deferred.succeed(gate, undefined);

      // The next delivery finds the card already showing the row and sends nothing.
      expect((yield* Fiber.join(retried)).deliveries).toEqual([]);
      expect(yield* Queue.size(apns.sent)).toBe(0);
    }),
  );

  it.effect(
    "resends the card after a crash between APNs accepting and the record, without the alert",
    () =>
      Effect.gen(function* () {
        const { apns, after } = yield* crashAfterApnsAccepts("waiting_for_approval");
        // The host retries the state its timed-out request carried.
        const retried = yield* publish(after, "h1", "waiting_for_approval");
        expect(yield* Queue.take(apns.sent)).toEqual({
          pushType: "liveactivity",
          event: "update",
          alert: null,
          rows: ["thread:waiting_for_approval"],
        });
        expect(retried.deliveries.map((delivery) => delivery.ok)).toEqual([true]);
        // Recorded now, so the same state again is skipped.
        expect((yield* publish(after, "h1", "waiting_for_approval")).deliveries).toEqual([]);
        expect(yield* Queue.size(apns.sent)).toBe(0);
      }),
  );

  it.effect("does not skip a state equal to the recorded one while a send is unrecorded", () =>
    Effect.gen(function* () {
      const { apns, after } = yield* crashAfterApnsAccepts("waiting_for_approval");
      // The approval is answered: the thread is back to the last recorded state,
      // but the phone may be showing the approval.
      yield* publish(after, "h1", "running");
      expect((yield* Queue.take(apns.sent)).rows).toEqual(["thread:running"]);
    }),
  );

  it.effect("keeps the alert after an APNs error and drops it after a timeout", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      yield* publish(push, "h1", "running");
      yield* Queue.take(apns.sent);
      apns.script.push(
        { _tag: "status", status: 500, reason: "InternalServerError" },
        { _tag: "hang" },
      );

      const asks = yield* startPublish(push, "h1", "waiting_for_approval");
      expect((yield* Queue.take(apns.sent)).alert).toBe("Thread on h1");
      yield* TestClock.adjust("1 second");
      // The error status means nothing reached the phone: the alert is still owed.
      expect((yield* Queue.take(apns.sent)).alert).toBe("Thread on h1");
      yield* TestClock.adjust("10 seconds");
      yield* TestClock.adjust("2 seconds");
      // The timed-out send may have rung already: the retry repaints without ringing.
      expect(yield* Queue.take(apns.sent)).toMatchObject({
        alert: null,
        rows: ["thread:waiting_for_approval"],
      });
      expect((yield* Fiber.join(asks)).deliveries.map((delivery) => delivery.ok)).toEqual([true]);
    }),
  );

  it.effect("ends a card with nothing left to show on the idle sweep", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup({ sweep: true });
      yield* registerPhone(push, { card: true });
      yield* publish(push, "h1", "completed");
      expect((yield* Queue.take(apns.sent)).rows).toEqual(["thread:completed"]);

      // The finished row's 15 minute display window passes with no publish.
      yield* TestClock.adjust("16 minutes");
      expect(yield* Queue.take(apns.sent)).toMatchObject({ event: "end", rows: [] });
      expect(yield* push.snapshot).toEqual({ aggregate: null });
    }),
  );

  it.effect("repaints a newly registered card without ringing", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      expect((yield* publish(push, "h1", "waiting_for_approval")).deliveries).toEqual([]);
      yield* registerPhone(push, { card: true });
      expect(yield* Queue.take(apns.sent)).toEqual({
        pushType: "liveactivity",
        event: "update",
        alert: null,
        rows: ["thread:waiting_for_approval"],
      });
    }),
  );

  it.effect("pushes a notification to a phone without a card, and drops a card APNs retired", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      apns.script.push({ _tag: "status", status: 410, reason: "Unregistered" });
      yield* publish(push, "h1", "running");
      expect((yield* Queue.take(apns.sent)).pushType).toBe("liveactivity");

      const asks = yield* publish(push, "h1", "waiting_for_approval");
      expect(yield* Queue.take(apns.sent)).toMatchObject({
        pushType: "alert",
        alert: "Thread on h1",
      });
      expect(asks.deliveries.map((delivery) => delivery.kind)).toEqual(["push_notification"]);
    }),
  );
});
