import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { RunId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as Callbacks from "./callbacks.ts";
import { BridgeError, Environments, type T3Environment } from "./environment.ts";
import { at, bridgeLayer, callTool, projection, run, threadId, threadServer } from "./testing.ts";
import { reportSessionStatus } from "./tools.ts";

type Ready = (projection: OrchestrationV2ThreadProjection) => boolean;
type Watch = (
  ready: Ready,
) => Effect.Effect<
  { readonly projection: OrchestrationV2ThreadProjection; readonly settled: boolean },
  BridgeError
>;
interface Post {
  readonly authorization: string | undefined;
  readonly event: {
    readonly event_id: string;
    readonly status?: { readonly state: string; readonly timed_out?: boolean };
  };
}

const finishedOne = run({ status: "completed", completedAt: DateTime.makeUnsafe(at(20)) });
/** A later turn running, after the one the callback was set on finished. */
const laterTurn = projection({
  runs: [
    finishedOne,
    run({
      id: RunId.make("run-2"),
      ordinal: 2,
      status: "running",
      startedAt: DateTime.makeUnsafe(at(21)),
    }),
  ],
});
const target = {
  url: "https://hooks.example.com/t3",
  headers: [{ name: "Authorization", value: "Bearer receiver-key" }],
};

/** A server whose watches play `watches` in order, and a receiver answering `statuses` in order. */
const makeHarness = Effect.gen(function* () {
  const watches = yield* Queue.unbounded<Watch>();
  const watched = yield* Queue.unbounded<void>();
  const posts = yield* Queue.unbounded<Post>();
  const statuses: Array<number> = [];
  const { environment } = threadServer(projection(), undefined, {
    waitForThread: (_threadId, ready) =>
      Queue.take(watches).pipe(
        Effect.tap(() => Queue.offer(watched, undefined)),
        Effect.flatMap((watch) => watch(ready)),
      ),
  });
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("expected a JSON body");
      yield* Queue.offer(posts, {
        authorization: request.headers["authorization"],
        event: JSON.parse(new TextDecoder().decode(request.body.body)),
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: statuses.shift() ?? 200 }),
      );
    }),
  );
  const dataDir = yield* FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.makeTempDirectoryScoped()),
  );
  const tools = (server: T3Environment = environment) =>
    bridgeLayer(
      server,
      Layer.effect(
        Callbacks.SessionCallbacks,
        Callbacks.make({ dataDir, report: reportSessionStatus }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              Environments,
              Environments.of({
                enabled: Effect.succeed([server]),
                get: () => Effect.succeed(server),
              }),
            ),
            Layer.succeed(HttpClient.HttpClient, http),
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
        Layer.orDie,
      ),
    );
  const ends =
    (current: OrchestrationV2ThreadProjection): Watch =>
    (ready) =>
      Effect.succeed({ projection: current, settled: ready(current) });
  return { watches, watched, posts, statuses, tools, ends, dataDir };
});

const arm = callTool("set_session_callback", {
  server_id: "home",
  session_id: threadId,
  callback: target,
});

describe("set_session_callback", () => {
  it.effect("POSTs the status with the receiver's headers once the turn ends", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const armed = yield* arm;
        expect(armed).toMatchObject({ state: "running" });
        expect(armed.next_step).toContain("callback.url");
        const status = yield* callTool("get_session_status", {
          server_id: "home",
          session_id: threadId,
        });
        expect(status.callback).toEqual(armed.callback);

        yield* Queue.offer(harness.watches, harness.ends(laterTurn));
        const post = yield* Queue.take(harness.posts);
        expect(post.authorization).toBe("Bearer receiver-key");
        expect(post.event).toMatchObject({
          event: "session.status",
          event_id: armed.callback?.callback_id,
          server_id: "home",
          session_id: threadId,
          status: { state: "running", timed_out: false },
        });
      }).pipe(Effect.provide(harness.tools()));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("waits out an unreachable server and retries a failed POST with the same event", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.statuses.push(503);
      yield* Effect.gen(function* () {
        const armed = yield* arm;
        yield* Queue.offer(harness.watches, () =>
          Effect.fail(new BridgeError({ message: "connection refused" })),
        );
        yield* Queue.take(harness.watched);
        yield* TestClock.adjust("30 seconds");
        yield* Queue.offer(harness.watches, harness.ends(laterTurn));
        const first = yield* Queue.take(harness.posts);
        yield* TestClock.adjust("5 seconds");
        const second = yield* Queue.take(harness.posts);
        expect(first.event.event_id).toBe(armed.callback?.callback_id);
        expect(second.event).toEqual(first.event);
      }).pipe(Effect.provide(harness.tools()));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resumes after a restart, still waiting on the turn it was set on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const armed = yield* arm.pipe(Effect.provide(harness.tools()));
      const post = yield* Effect.gen(function* () {
        yield* Queue.offer(harness.watches, harness.ends(laterTurn));
        return yield* Queue.take(harness.posts);
      }).pipe(Effect.provide(harness.tools()));
      expect(post.event.event_id).toBe(armed.callback?.callback_id);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels with null and refuses a target that is not https", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const refused = yield* Effect.flip(
          callTool("set_session_callback", {
            server_id: "home",
            session_id: threadId,
            callback: { url: "http://hooks.example.com/t3" },
          }),
        );
        expect(refused.message).toBe("callback.url must use https.");

        yield* arm;
        const cancelled = yield* callTool("set_session_callback", {
          server_id: "home",
          session_id: threadId,
          callback: null,
        });
        expect(cancelled.callback).toBeNull();
        const status = yield* callTool("get_session_status", {
          server_id: "home",
          session_id: threadId,
        });
        expect(status.callback).toBeUndefined();
      }).pipe(Effect.provide(harness.tools()));
      const fileSystem = yield* FileSystem.FileSystem;
      expect(yield* fileSystem.readFileString(`${harness.dataDir}/callbacks.json`)).toBe("[]");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
