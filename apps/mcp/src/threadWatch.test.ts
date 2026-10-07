import { describe, expect, it } from "@effect/vitest";
import { EventId, type OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BridgeError } from "./errors.ts";
import { appThread, at, NOW, projection, run, threadId } from "./testing.ts";
import { waitForThreadState } from "./threadWatch.ts";

const preparing = projection({ runs: [run({ status: "preparing", startedAt: null })] });
const snapshot: OrchestrationV2ThreadStreamItem = {
  kind: "snapshot",
  snapshotSequence: 1,
  projection: preparing,
};
const runUpdated = (status: "running" | "failed"): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence: 2,
  event: {
    id: EventId.make("event-2"),
    threadId,
    occurredAt: DateTime.makeUnsafe(at(20)),
    type: "run.updated",
    payload: run({ status }),
  },
});
const prepared = (current: typeof preparing) =>
  current.runs.some((candidate) => candidate.status !== "preparing");

describe("waitForThreadState", () => {
  it.effect("applies live events with the clients' projection reducer before checking", () =>
    Effect.gen(function* () {
      const result = yield* waitForThreadState(
        Stream.fromIterable([
          snapshot,
          { kind: "synchronized" } as const,
          { kind: "unknown-event", sequence: 2, eventType: "future.event" } as const,
          runUpdated("running"),
        ]),
        prepared,
      );
      expect(result.runs.map((candidate) => candidate.status)).toEqual(["running"]);
    }),
  );

  it.effect("returns the snapshot itself when it already satisfies the condition", () =>
    Effect.gen(function* () {
      const deleted = projection({ thread: appThread({ deletedAt: DateTime.makeUnsafe(NOW) }) });
      const result = yield* waitForThreadState(
        Stream.succeed({ kind: "snapshot", snapshotSequence: 3, projection: deleted }),
        (current) => current.thread.deletedAt !== null,
      );
      expect(result.thread.deletedAt).not.toBeNull();
    }),
  );

  it.effect("reports a closed or failed subscription", () =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.flip(waitForThreadState(Stream.succeed(snapshot), prepared))).message,
      ).toContain("ended");
      const failure = new BridgeError({ message: "Connection lost" });
      expect(yield* Effect.flip(waitForThreadState(Stream.fail(failure), prepared))).toBe(failure);
    }),
  );
});
