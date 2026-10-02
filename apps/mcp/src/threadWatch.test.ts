import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BridgeError } from "./errors.ts";
import { activity, NOW, thread } from "./testing.ts";
import { waitForThreadState } from "./threadWatch.ts";

const snapshot: OrchestrationThreadStreamItem = {
  kind: "snapshot",
  snapshot: { snapshotSequence: 1, thread: thread() },
};
const event = <T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    type,
    payload,
    sequence: 2,
    eventId: EventId.make("event-2"),
    aggregateKind: "thread",
    aggregateId: thread().id,
    occurredAt: NOW,
    commandId: CommandId.make("command-2"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as OrchestrationEvent,
});

describe("queued thread subscription", () => {
  it.effect(
    "applies live events with the canonical client reducer before checking the boundary",
    () =>
      Effect.gen(function* () {
        const result = yield* waitForThreadState(
          Stream.fromIterable([
            snapshot,
            { kind: "synchronized" } as const,
            event("thread.activity-appended", {
              threadId: thread().id,
              activity: activity("tool-1", "tool.completed", 20),
            }),
          ]),
          (thread) => thread.activities.some((activity) => activity.kind === "tool.completed"),
        );
        expect(result.activities.map((activity) => activity.id)).toEqual(["tool-1"]);
      }),
  );

  it.effect(
    "cancels on Stop and deletion instead of releasing at the resulting idle boundary",
    () =>
      Effect.gen(function* () {
        for (const stopped of [
          event("thread.turn-interrupt-requested", { threadId: thread().id, createdAt: NOW }),
          event("thread.deleted", { threadId: thread().id, deletedAt: NOW }),
        ]) {
          const error = yield* Effect.flip(
            waitForThreadState(Stream.fromIterable([snapshot, stopped]), () => false),
          );
          expect(error).toMatchObject({ code: "queue_cancelled" });
        }
      }),
  );

  it.effect("detects Stop completed before subscribing from the initial snapshot", () =>
    Effect.gen(function* () {
      const interrupted: OrchestrationThreadStreamItem = {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 2,
          thread: thread({
            session: { ...thread().session!, status: "ready", activeTurnId: null },
            latestTurn: { ...thread().latestTurn!, state: "interrupted", completedAt: NOW },
          }),
        },
      };
      expect(
        yield* Effect.flip(waitForThreadState(Stream.succeed(interrupted), () => true)),
      ).toMatchObject({ code: "queue_cancelled" });
    }),
  );

  it.effect("reports a closed or failed subscription without dispatching", () =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.flip(waitForThreadState(Stream.succeed(snapshot), () => false))).message,
      ).toContain("ended");
      const failure = new BridgeError({ message: "Connection lost" });
      expect(yield* Effect.flip(waitForThreadState(Stream.fail(failure), () => true))).toBe(
        failure,
      );
    }),
  );
});
