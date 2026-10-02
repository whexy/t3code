import type { ClientOrchestrationCommand, OrchestrationThread } from "@t3tools/contracts";
import {
  isQueuedMessageDue,
  latestCompletedToolActivityId,
} from "@t3tools/client-runtime/queued-messages";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import type { T3Environment } from "./environment.ts";
import { threadState } from "./status.ts";

type StartTurn = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

interface PendingMessage {
  readonly command: StartTurn;
  readonly anchor: string | null;
  status: "queued" | "dispatching" | "failed" | "cancelled";
  error?: string;
}

/** Like the web composer, this queue is a live intent owned by the bridge's lifetime. */
export const makeMessageQueue = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const queues = new Map<string, PendingMessage[]>();
  const workers = new Map<string, Fiber.Fiber<void, never>>();
  const key = (serverId: string, threadId: string) => JSON.stringify([serverId, threadId]);

  const list = (serverId: string, threadId: string) =>
    (queues.get(key(serverId, threadId)) ?? []).map((entry) => ({
      message_id: entry.command.message.messageId,
      state: entry.status,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }));

  const cancel = Effect.fn("MessageQueue.cancel")(function* (serverId: string, threadId: string) {
    const queueKey = key(serverId, threadId);
    const entries = queues.get(queueKey) ?? [];
    const cancelled = entries.filter((entry) => entry.status === "queued");
    for (const entry of cancelled) entry.status = "cancelled";
    const worker = workers.get(queueKey);
    if (worker !== undefined && !entries.some((entry) => entry.status === "dispatching")) {
      yield* Fiber.interrupt(worker);
    }
    return cancelled.map((entry) => entry.command.message.messageId);
  });

  const enqueue = Effect.fn("MessageQueue.enqueue")(function* (
    environment: T3Environment,
    thread: OrchestrationThread,
    command: StartTurn,
  ) {
    const queueKey = key(environment.id, thread.id);
    const entry: PendingMessage = {
      command,
      anchor: latestCompletedToolActivityId(thread.activities),
      status: "queued",
    };
    const entries = queues.get(queueKey) ?? [];
    entries.push(entry);
    queues.set(queueKey, entries);
    const existing = workers.get(queueKey);
    if (existing !== undefined) return existing;

    const work = Effect.gen(function* () {
      let previousDispatch = false;
      while (true) {
        const next = entries.find((entry) => entry.status === "queued");
        if (next === undefined) return;
        // Only one message leaves per boundary; following messages re-anchor
        // after the previous send, as the web queue's beginSend does.
        const anchor = previousDispatch
          ? latestCompletedToolActivityId((yield* environment.thread(thread.id)).thread.activities)
          : next.anchor;
        const ready = yield* environment.waitForThread(thread.id, (current, now) => {
          const state = threadState(current, now);
          if (state === "waiting" || state === "queued") return false;
          return isQueuedMessageDue({
            message: { queuedAfterToolActivityId: anchor },
            phase:
              current.session?.status === "starting"
                ? "connecting"
                : current.session?.status === "running"
                  ? "running"
                  : "ready",
            latestToolActivityId: latestCompletedToolActivityId(current.activities),
          });
        });
        if (next.status !== "queued") continue;
        next.status = "dispatching";
        yield* environment.startTurn({
          ...next.command,
          runtimeMode: ready.runtimeMode,
          interactionMode: ready.interactionMode,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        entries.splice(entries.indexOf(next), 1);
        previousDispatch = true;
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          for (const pending of entries) {
            if (pending.status !== "queued" && pending.status !== "dispatching") continue;
            pending.status = error.code === "queue_cancelled" ? "cancelled" : "failed";
            pending.error = error.message;
          }
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          workers.delete(queueKey);
          if (entries.length === 0) queues.delete(queueKey);
        }),
      ),
    );
    const worker = yield* work.pipe(Effect.forkIn(scope));
    workers.set(queueKey, worker);
    return worker;
  });

  return { enqueue, cancel, list };
});
