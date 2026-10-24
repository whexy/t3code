import { describe, expect, it } from "@effect/vitest";
import { RunId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  approvalItem,
  assistantMessage,
  at,
  callTool,
  completed,
  projection,
  run,
  runtimeRequest,
  threadId,
  threadServer,
  userMessage,
} from "./testing.ts";
import { waitForThreadState } from "./threadWatch.ts";

const user = userMessage("user-1", "Fix the flaky test", 1);
const runTwo = (status: "queued" | "running" | "completed") =>
  run({
    id: RunId.make("run-2"),
    ordinal: 2,
    status,
    startedAt: status === "queued" ? null : DateTime.makeUnsafe(at(21)),
    completedAt: status === "completed" ? DateTime.makeUnsafe(at(25)) : null,
  });
const finishedOne = run({ status: "completed", completedAt: DateTime.makeUnsafe(at(20)) });
const reply = assistantMessage("reply", "Fixed the retry loop", 20);

/**
 * A server whose subscription sends each projection in turn as a snapshot.
 * `open` keeps it open afterwards, as a live subscription stays.
 */
function watching(projections: ReadonlyArray<OrchestrationV2ThreadProjection>, open = false) {
  const snapshots = Stream.fromIterable(
    projections.map((current, index) => ({
      kind: "snapshot" as const,
      snapshotSequence: index + 1,
      projection: current,
    })),
  );
  return threadServer(projections[0]!, undefined, {
    waitForThread: (_threadId, ready, withinMs) =>
      waitForThreadState(
        open ? Stream.concat(snapshots, Stream.never) : snapshots,
        ready,
        withinMs,
      ),
  });
}

const waitForStatus = callTool("get_session_status", {
  server_id: "home",
  session_id: threadId,
  wait: true,
});

describe("get_session_status wait", () => {
  it.effect("returns when the turn it waited on ends, though a message queued later starts", () =>
    Effect.gen(function* () {
      const status = yield* waitForStatus.pipe(
        Effect.provide(
          watching([
            projection(),
            projection({ runs: [finishedOne, runTwo("running")], items: [user, reply] }),
          ]).layer,
        ),
      );
      expect(status).toMatchObject({ state: "running", timed_out: false });
      expect(status.updates.at(-1)).toMatchObject({ text: "Fixed the retry loop" });
      expect(status.next_step).toContain("still working");
    }),
  );

  it.effect("waits through work already queued when it began", () =>
    Effect.gen(function* () {
      const status = yield* waitForStatus.pipe(
        Effect.provide(
          watching([
            projection({ runs: [run(), runTwo("queued")] }),
            projection({ runs: [finishedOne, runTwo("running")], items: [user, reply] }),
            projection({ runs: [finishedOne, runTwo("completed")], items: [user, reply] }),
          ]).layer,
        ),
      );
      expect(status).toMatchObject({ state: "completed", timed_out: false });
      expect(status.next_step).toContain("finished");
    }),
  );

  it.effect("returns at once when the agent needs the user or nothing is running", () =>
    Effect.gen(function* () {
      const waiting = projection({
        items: [user, approvalItem("request-1", 3)],
        runtimeRequests: [runtimeRequest("request-1", "command")],
      });
      const asking = yield* waitForStatus.pipe(Effect.provide(watching([waiting]).layer));
      expect(asking).toMatchObject({ state: "waiting", timed_out: false });
      expect(asking.next_step).toContain("respond_to_session");

      const done = yield* waitForStatus.pipe(Effect.provide(watching([completed]).layer));
      expect(done).toMatchObject({ state: "completed", timed_out: false });
    }),
  );

  it.effect("reports progress, not an error, when the turn outlasts the wait", () =>
    Effect.gen(function* () {
      const fiber = yield* waitForStatus.pipe(
        Effect.provide(watching([projection()], true).layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust("45 seconds");
      const status = yield* Fiber.join(fiber);
      expect(status).toMatchObject({ state: "running", timed_out: true });
      expect(status.next_step).toContain("wait: true");
    }),
  );

  it.effect("reports immediately without wait", () =>
    Effect.gen(function* () {
      const status = yield* callTool("get_session_status", {
        server_id: "home",
        session_id: threadId,
      }).pipe(Effect.provide(threadServer(projection()).layer));
      expect(status.state).toBe("running");
      expect(status.timed_out).toBeUndefined();
    }),
  );
});
