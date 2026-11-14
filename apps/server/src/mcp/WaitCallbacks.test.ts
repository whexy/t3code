import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  type OrchestratorMcpThreadWaitResult,
  type OrchestratorMcpWaitCallbackEvent,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as WaitCallbacks from "./WaitCallbacks.ts";

const threadId = ThreadId.make("thread:wait-callbacks");
const runId = RunId.make("run:wait-callbacks");
const outsideClient = {
  sessionId: "session-wait-callbacks",
  label: "Grok",
  access: "full-access",
} as const;
const outside: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:wait-callbacks"),
  requestNamespace: "client:wait-callbacks",
  thread: undefined,
  client: outsideClient,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const callback = {
  url: "https://hooks.example.com/t3",
  headers: [{ name: "Authorization", value: "Bearer receiver-key" }],
};
const running: OrchestratorMcpThreadWaitResult = {
  threadId,
  runId,
  status: "running",
  timedOut: true,
};
const completed: OrchestratorMcpThreadWaitResult = {
  threadId,
  runId,
  status: "completed",
  timedOut: false,
};

const makeHarness = Effect.gen(function* () {
  return {
    secrets: new Map<string, Uint8Array>(),
    cleared: yield* Deferred.make<void>(),
    finished: yield* Deferred.make<OrchestratorMcpThreadWaitResult>(),
    revoked: yield* Deferred.make<void>(),
    posts: yield* Queue.unbounded<{
      readonly authorization: string | undefined;
      readonly event: OrchestratorMcpWaitCallbackEvent;
    }>(),
    statuses: [] as Array<number>,
    longWaits: 0,
  };
});
type Harness = Effect.Success<typeof makeHarness>;

const layerFor = (harness: Harness, options: { readonly webhooksDenied?: boolean } = {}) =>
  Layer.effect(WaitCallbacks.WaitCallbacks, WaitCallbacks.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        ManagedPolicy.layerTest(
          options.webhooksDenied === true
            ? { schemaVersion: 1, organization: "Acme", limits: { webhookTasks: false } }
            : undefined,
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              if (request.body._tag === "Uint8Array") {
                yield* Queue.offer(harness.posts, {
                  authorization: request.headers["authorization"],
                  event: JSON.parse(new TextDecoder().decode(request.body.body)),
                });
              }
              const status = harness.statuses.shift() ?? 200;
              return HttpClientResponse.fromWeb(request, new Response(null, { status }));
            }),
          ),
        ),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => Effect.sync(() => Option.fromNullishOr(harness.secrets.get(name))),
          set: (name, value) => Effect.sync(() => void harness.secrets.set(name, value)),
          remove: (name) =>
            Effect.sync(() => void harness.secrets.delete(name)).pipe(
              Effect.andThen(Deferred.succeed(harness.cleared, undefined)),
            ),
        }),
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "t3_session",
          legacyCookieName: undefined,
          awaitInvalidation: () => Deferred.await(harness.revoked),
        }),
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
          waitForThread: (_scope, input) =>
            input.timeoutMs === 1
              ? Effect.succeed(running)
              : Effect.sync(() => harness.longWaits++).pipe(
                  Effect.andThen(Deferred.await(harness.finished)),
                ),
        }),
      ),
    ),
  );

const storedEvent = (harness: Harness) => {
  const bytes = harness.secrets.get("mcp-wait-callbacks");
  return bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes))[0]?.event;
};

it.effect(
  "posts the result with the receiver's key and resends the same event after a restart",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.statuses = [503];
      const armed = yield* Effect.gen(function* () {
        const callbacks = yield* WaitCallbacks.WaitCallbacks;
        const result = yield* callbacks.set(outside, { threadId, callback });
        yield* Deferred.succeed(harness.finished, completed);
        const refused = yield* Queue.take(harness.posts);
        assert.equal(refused.authorization, "Bearer receiver-key");
        assert.deepInclude(refused.event, { event: "thread.wait", threadId, result: completed });
        return result;
      }).pipe(Effect.provide(layerFor(harness)));
      assert.deepInclude(armed, { status: "running" });
      assert.equal(storedEvent(harness)?.eventId, armed.callback?.id);

      yield* Effect.gen(function* () {
        const callbacks = yield* WaitCallbacks.WaitCallbacks;
        yield* callbacks.start();
        const resent = yield* Queue.take(harness.posts);
        assert.equal(resent.event.eventId, armed.callback?.id);
        assert.deepEqual(resent.event.result, completed);
        yield* Deferred.await(harness.cleared);
      }).pipe(Effect.provide(layerFor(harness)));
      assert.equal(harness.longWaits, 1);
    }),
);

it.effect("drops a callback without posting when its client is revoked or cancels it", () =>
  Effect.gen(function* () {
    const revokedHarness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const callbacks = yield* WaitCallbacks.WaitCallbacks;
      yield* callbacks.set(outside, { threadId, callback });
      yield* Deferred.succeed(revokedHarness.revoked, undefined);
      yield* Deferred.await(revokedHarness.cleared);
    }).pipe(Effect.provide(layerFor(revokedHarness)));
    assert.equal(yield* Queue.size(revokedHarness.posts), 0);

    const cancelledHarness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const callbacks = yield* WaitCallbacks.WaitCallbacks;
      yield* callbacks.set(outside, { threadId, callback });
      const cancelled = yield* callbacks.set(outside, { threadId, callback: null });
      assert.isNull(cancelled.callback);
      yield* Deferred.succeed(cancelledHarness.finished, completed);
    }).pipe(Effect.provide(layerFor(cancelledHarness)));
    assert.isTrue(yield* Deferred.isDone(cancelledHarness.cleared));
    assert.equal(yield* Queue.size(cancelledHarness.posts), 0);
  }),
);

it.effect("refuses callbacks for agents in T3, read-only clients and denied webhooks", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const refusal = (scope: McpInvocationScope, webhooksDenied = false) =>
      Effect.gen(function* () {
        const callbacks = yield* WaitCallbacks.WaitCallbacks;
        return (yield* callbacks.set(scope, { threadId, callback }).pipe(Effect.flip)).code;
      }).pipe(Effect.provide(layerFor(harness, { webhooksDenied })));

    assert.deepEqual(
      [
        yield* refusal({
          ...outside,
          thread: {
            threadId,
            providerSessionId: "provider-session:wait-callbacks",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        }),
        yield* refusal({ ...outside, client: { ...outsideClient, linked: true } }),
        yield* refusal({ ...outside, client: { ...outsideClient, access: "read-only" } }),
        yield* refusal(outside, true),
      ],
      ["invalid_request", "invalid_request", "capability_denied", "capability_denied"],
    );
    assert.equal(harness.secrets.size, 0);
  }),
);
