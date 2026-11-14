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
    alert: Schema.optional(
      Schema.Struct({
        title: Schema.String,
        body: Schema.String,
        sound: Schema.optional(Schema.String),
      }),
    ),
    sound: Schema.optional(Schema.String),
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
  readonly sound: string | null;
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
        sound: aps.alert?.sound ?? aps.sound ?? null,
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

const phoneRegistration = (liveActivitiesEnabled: boolean) => ({
  deviceId: "phone",
  label: "iPhone",
  platform: "ios" as const,
  iosMajorVersion: 18,
  apsEnvironment: "sandbox" as const,
  pushToken: "push-token",
  preferences: { ...preferences, liveActivitiesEnabled },
});

const registerPhone = (
  push: Push.Push["Service"],
  options: { readonly card: boolean; readonly liveActivitiesEnabled?: boolean },
) =>
  Effect.gen(function* () {
    yield* push.registerDevice(phoneRegistration(options.liveActivitiesEnabled ?? true));
    if (options.card) {
      yield* push.registerLiveActivity({ deviceId: "phone", activityPushToken: "activity-token" });
    }
  });

const decodeState = Schema.decodeUnknownSync(RelayAgentActivityState);

const threadState = (host: string, phase: RelayAgentAwarenessPhase) =>
  DateTime.now.pipe(
    Effect.map((now) =>
      decodeState({
        environmentId: host,
        threadId: "thread",
        projectTitle: "Project",
        threadTitle: `Thread on ${host}`,
        phase,
        headline: phase,
        modelTitle: "Model",
        updatedAt: DateTime.formatIso(now),
        deepLink: "/threads/thread",
      }),
    ),
  );

const publish = (push: Push.Push["Service"], host: string, phase: RelayAgentAwarenessPhase) =>
  threadState(host, phase).pipe(
    Effect.flatMap((state) => push.publish({ environmentId: host, threadId: "thread", state })),
  );

/** A host request in flight: started now, so its row is stored before this returns. */
const startPublish = (push: Push.Push["Service"], host: string, phase: RelayAgentAwarenessPhase) =>
  publish(push, host, phase).pipe(Effect.forkChild({ startImmediately: true }));

/** The host's thread is gone: an in-flight delete. */
const startUnpublish = (push: Push.Push["Service"], host: string) =>
  push
    .publish({ environmentId: host, threadId: "thread", state: null })
    .pipe(Effect.forkChild({ startImmediately: true }));

const isPending = (fiber: Fiber.Fiber<unknown, unknown>) => fiber.pollUnsafe() === undefined;

/**
 * A recorded card showing h1 running; then APNs accepts h1's move to `phase`
 * and the process dies before recording it. Returns the restarted process,
 * whose startup replay APNs answers with `replayReply`.
 */
const crashAfterApnsAccepts = (phase: RelayAgentAwarenessPhase, replayReply?: Reply) =>
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
    if (replayReply !== undefined) apns.script.push(replayReply);
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
      expect(coalesced).toMatchObject({ alert: "Thread on h1", sound: "default" });
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
    "resends the card on restart after a crash between APNs accepting and the record, without ringing again",
    () =>
      Effect.gen(function* () {
        const { apns, after } = yield* crashAfterApnsAccepts("waiting_for_approval");
        // The replay alerts against the write-ahead aggregate, which already holds the approval.
        expect(yield* Queue.take(apns.sent)).toEqual({
          pushType: "liveactivity",
          event: "update",
          alert: null,
          sound: null,
          rows: ["thread:waiting_for_approval"],
        });
        // Recorded now, so the host's retry of the state its failed request carried is skipped.
        expect((yield* publish(after, "h1", "waiting_for_approval")).deliveries).toEqual([]);
        expect(yield* Queue.size(apns.sent)).toBe(0);
      }),
  );

  it.effect("does not skip a state equal to the recorded one while a send is unrecorded", () =>
    Effect.gen(function* () {
      const { apns, after } = yield* crashAfterApnsAccepts("waiting_for_approval", {
        _tag: "status",
        status: 500,
        reason: "InternalServerError",
      });
      // The restart's replay is refused, so the send before the crash stays unrecorded.
      expect((yield* Queue.take(apns.sent)).rows).toEqual(["thread:waiting_for_approval"]);
      // The approval is answered: the thread is back to the last recorded state,
      // but the phone may be showing the approval.
      const runs = yield* startPublish(after, "h1", "running");
      yield* TestClock.adjust("1 second");
      expect((yield* Queue.take(apns.sent)).rows).toEqual(["thread:running"]);
      yield* Fiber.join(runs);
    }),
  );

  it.effect("alerts once on the startup replay for a row stored just before a crash", () =>
    Effect.gen(function* () {
      const apns = yield* fakeApns;
      const store = yield* Layer.build(PushStore.layer(":memory:"));
      const doomed = yield* Scope.make();
      const before = yield* startPush(store, apns.client, doomed);
      yield* registerPhone(before, { card: true });
      yield* publish(before, "h1", "running");
      yield* publish(before, "h1", "waiting_for_approval");
      expect((yield* Queue.clear(apns.sent)).map((sent) => sent.alert)).toEqual([
        null,
        "Thread on h1",
      ]);
      yield* Scope.close(doomed, Exit.void);
      // The process stored h2's approval and died before a delivery read it.
      const h2Asks = yield* threadState("h2", "waiting_for_approval");
      yield* Effect.sync(() => Context.get(store, PushStore.PushStore).upsertRow(h2Asks));

      const after = yield* startPush(store, apns.client, yield* Effect.scope);
      expect(yield* Queue.take(apns.sent)).toMatchObject({
        event: "update",
        alert: "Thread on h2",
      });
      // The host retries the request the crash failed.
      expect((yield* publish(after, "h2", "waiting_for_approval")).deliveries).toEqual([]);
      expect(yield* Queue.size(apns.sent)).toBe(0);
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

      // Nor does the approval ring as a notification once the card is gone.
      yield* registerPhone(push, { card: false, liveActivitiesEnabled: false });
      yield* publish(push, "h1", "waiting_for_approval");
      expect(yield* Queue.clear(apns.sent)).toMatchObject([{ event: "end", alert: null }]);
    }),
  );

  it.effect("notifies a card alert APNs refused once the card is gone", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      yield* publish(push, "h1", "running");
      yield* Queue.take(apns.sent);
      apns.script.push({ _tag: "status", status: 500, reason: "InternalServerError" });

      const asks = yield* startPublish(push, "h1", "waiting_for_approval");
      expect((yield* Queue.take(apns.sent)).alert).toBe("Thread on h1");
      // Before the retry, the phone turns Live Activities off.
      yield* registerPhone(push, { card: false, liveActivitiesEnabled: false });
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(asks);
      expect(yield* Queue.clear(apns.sent)).toMatchObject([
        { pushType: "liveactivity", event: "end", alert: null },
        { pushType: "alert", alert: "Thread on h1" },
      ]);
    }),
  );

  it.effect("does not notify a phase the card alerted after Live Activities turn off", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      yield* publish(push, "h1", "running");
      yield* publish(push, "h1", "waiting_for_approval");
      yield* registerPhone(push, { card: false, liveActivitiesEnabled: false });
      // A title change, or a host retrying after its timeout.
      yield* publish(push, "h1", "waiting_for_approval");
      expect(yield* Queue.clear(apns.sent)).toMatchObject([
        { event: "update", alert: null },
        { event: "update", alert: "Thread on h1" },
        { event: "end", alert: null },
      ]);
    }),
  );

  it.effect("rings a card completion with the completion sound", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      yield* publish(push, "h1", "running");
      yield* publish(push, "h1", "completed");
      expect(yield* Queue.clear(apns.sent)).toMatchObject([
        { event: "update", alert: null },
        { event: "update", alert: "Thread on h1", sound: "notification-completion.wav" },
      ]);
    }),
  );

  it.effect("alerts an ask and a completion delivered together once, naming both", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      yield* publish(push, "h2", "running");
      const gate = yield* Deferred.make<void>();
      apns.script.push({ _tag: "gate", gate });
      const h1Runs = yield* startPublish(push, "h1", "running");
      yield* Queue.take(apns.sent);

      const together = [
        yield* startPublish(push, "h1", "waiting_for_input"),
        yield* startPublish(push, "h2", "completed"),
      ];
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(h1Runs);
      yield* Fiber.joinAll(together);
      yield* registerPhone(push, { card: false, liveActivitiesEnabled: false });
      // A title change, or a host retrying after its timeout.
      yield* publish(push, "h2", "completed");
      expect(yield* Queue.clear(apns.sent)).toMatchObject([
        {
          event: "update",
          alert: "Thread on h1 needs input · Thread on h2 done",
          sound: "default",
        },
        { event: "end", alert: null },
      ]);
    }),
  );

  it.effect("notifies a thread that asks while an end of unknown outcome is pending", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      yield* publish(push, "h1", "running");
      yield* Queue.take(apns.sent);
      apns.script.push({ _tag: "hang" });
      const h1Gone = yield* startUnpublish(push, "h1");
      expect((yield* Queue.take(apns.sent)).event).toBe("end");

      // The end times out after reaching the phone, which no longer shows a card.
      const h2Asks = yield* startPublish(push, "h2", "waiting_for_approval");
      yield* TestClock.adjust("10 seconds");
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(h1Gone);
      yield* Fiber.join(h2Asks);
      expect(yield* Queue.clear(apns.sent)).toMatchObject([
        { pushType: "liveactivity", event: "end", alert: null },
        { pushType: "alert", alert: "Thread on h2" },
      ]);
    }),
  );

  it.effect("resends an end of unknown outcome until APNs accepts one", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      yield* publish(push, "h1", "running");
      yield* Queue.take(apns.sent);
      apns.script.push(
        { _tag: "hang" },
        { _tag: "status", status: 500, reason: "InternalServerError" },
      );
      const h1Gone = yield* startUnpublish(push, "h1");
      yield* Queue.take(apns.sent);

      // The end may never have reached the phone, which still shows h1 running.
      const h2Runs = yield* startPublish(push, "h2", "running");
      yield* TestClock.adjust("10 seconds");
      yield* TestClock.adjust("2 seconds");
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(h1Gone);
      yield* Fiber.join(h2Runs);
      expect((yield* Queue.clear(apns.sent)).map((sent) => [sent.event, sent.alert])).toEqual([
        ["end", null],
        ["end", null],
      ]);
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
        sound: null,
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

  it.effect("does not re-notify a waiting thread when another thread publishes", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: false, liveActivitiesEnabled: false });
      yield* publish(push, "h1", "waiting_for_approval");
      expect(yield* Queue.take(apns.sent)).toMatchObject({
        pushType: "alert",
        alert: "Thread on h1",
      });
      // h1's approval is still the first row of the card this phone does not have.
      expect((yield* publish(push, "h2", "running")).deliveries).toEqual([]);
      expect(yield* Queue.size(apns.sent)).toBe(0);
    }),
  );

  it.effect("notifies a thread once per phase however often its host republishes it", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: false, liveActivitiesEnabled: false });
      apns.script.push({ _tag: "status", status: 500, reason: "InternalServerError" });
      const asks = yield* startPublish(push, "h1", "waiting_for_approval");
      expect((yield* Queue.take(apns.sent)).alert).toBe("Thread on h1");
      yield* TestClock.adjust("1 second");
      // The refusal reached nothing, so the retry still rings.
      expect((yield* Queue.take(apns.sent)).alert).toBe("Thread on h1");
      yield* Fiber.join(asks);

      // A title change, or a host retrying after its timeout, publishes the same phase again.
      expect((yield* publish(push, "h1", "waiting_for_approval")).deliveries).toEqual([]);
      yield* publish(push, "h1", "running");
      yield* publish(push, "h1", "waiting_for_approval");
      expect(yield* Queue.clear(apns.sent)).toMatchObject([
        { pushType: "alert", alert: "Thread on h1" },
      ]);
    }),
  );

  it.effect("does not repeat a notification APNs may have taken before a crash", () =>
    Effect.gen(function* () {
      const apns = yield* fakeApns;
      const store = yield* Layer.build(PushStore.layer(":memory:"));
      const doomed = yield* Scope.make();
      const before = yield* startPush(store, apns.client, doomed);
      yield* registerPhone(before, { card: false, liveActivitiesEnabled: false });
      apns.script.push({ _tag: "hang" });
      const lost = yield* startPublish(before, "h1", "waiting_for_approval");
      expect((yield* Queue.take(apns.sent)).alert).toBe("Thread on h1");
      yield* Scope.close(doomed, Exit.void);
      yield* Fiber.interrupt(lost);

      const after = yield* startPush(store, apns.client, yield* Effect.scope);
      // The host retries the request the crash failed.
      expect((yield* publish(after, "h1", "waiting_for_approval")).deliveries).toEqual([]);
      expect(yield* Queue.size(apns.sent)).toBe(0);
    }),
  );

  it.effect("notifies a thread's completion while another thread is running", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: false, liveActivitiesEnabled: false });
      yield* publish(push, "h1", "running");
      yield* publish(push, "h2", "running");
      // h1's running row sorts ahead of h2's finished one.
      yield* publish(push, "h2", "completed");
      expect(yield* Queue.clear(apns.sent)).toMatchObject([
        { pushType: "alert", alert: "Thread on h2", sound: "notification-completion.wav" },
      ]);
    }),
  );

  it.effect("notifies once per thread for publishes coalesced into one delivery", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: false, liveActivitiesEnabled: false });
      const gate = yield* Deferred.make<void>();
      apns.script.push({ _tag: "gate", gate });
      const h1Asks = yield* startPublish(push, "h1", "waiting_for_approval");
      expect((yield* Queue.take(apns.sent)).alert).toBe("Thread on h1");

      const coalesced = [
        yield* startPublish(push, "h2", "waiting_for_input"),
        yield* startPublish(push, "h3", "completed"),
        yield* startPublish(push, "h4", "completed"),
        // Supersedes h2's input request before any delivery read it.
        yield* startPublish(push, "h2", "running"),
      ];
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(h1Asks);
      yield* Fiber.joinAll(coalesced);
      expect((yield* Queue.clear(apns.sent)).map((sent) => sent.alert)).toEqual([
        "Thread on h3",
        "Thread on h4",
      ]);
    }),
  );

  it.effect("ends the card of a phone that turned Live Activities off and notifies instead", () =>
    Effect.gen(function* () {
      const { apns, push } = yield* setup();
      yield* registerPhone(push, { card: true });
      const gate = yield* Deferred.make<void>();
      apns.script.push({ _tag: "gate", gate });
      const h1Runs = yield* startPublish(push, "h1", "running");
      expect((yield* Queue.take(apns.sent)).rows).toEqual(["thread:running"]);

      yield* registerPhone(push, { card: false, liveActivitiesEnabled: false });
      const h1Asks = yield* startPublish(push, "h1", "waiting_for_approval");
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(h1Runs);
      yield* Fiber.join(h1Asks);
      expect(yield* Queue.clear(apns.sent)).toMatchObject([
        { pushType: "liveactivity", event: "end", alert: null },
        { pushType: "alert", alert: "Thread on h1" },
      ]);
    }),
  );

  it.effect("ends the card of a phone that turned Live Activities off just before a crash", () =>
    Effect.gen(function* () {
      const apns = yield* fakeApns;
      const store = yield* Layer.build(PushStore.layer(":memory:"));
      const doomed = yield* Scope.make();
      const before = yield* startPush(store, apns.client, doomed);
      yield* registerPhone(before, { card: true });
      yield* publish(before, "h1", "running");
      expect((yield* Queue.take(apns.sent)).rows).toEqual(["thread:running"]);
      yield* Scope.close(doomed, Exit.void);
      // The process stored the switch and died before the replay that would end the card ran.
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.sync(() =>
        Context.get(store, PushStore.PushStore).registerDevice(phoneRegistration(false), now),
      );

      yield* startPush(store, apns.client, yield* Effect.scope);
      expect(yield* Queue.take(apns.sent)).toMatchObject({
        pushType: "liveactivity",
        event: "end",
        alert: null,
      });
    }),
  );
});
