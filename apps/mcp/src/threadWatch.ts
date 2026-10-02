import type { OrchestrationThread, OrchestrationThreadStreamItem } from "@t3tools/contracts";
import { applyThreadDetailEvent } from "@t3tools/client-runtime/state/thread-reducer";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BridgeError } from "./errors.ts";
import { threadState } from "./status.ts";

/** Stop cancels held intent; it must not restart the agent at the ensuing idle boundary. */
export const waitForThreadState = <E, R>(
  updates: Stream.Stream<OrchestrationThreadStreamItem, E, R>,
  ready: (thread: OrchestrationThread, now: string) => boolean,
) =>
  Effect.suspend(() => {
    let current: OrchestrationThread | undefined;
    return updates.pipe(
      Stream.mapEffect((item) =>
        Effect.gen(function* () {
          if (item.kind === "snapshot") current = item.snapshot.thread;
          if (item.kind === "event") {
            if (
              item.event.type === "thread.turn-interrupt-requested" ||
              item.event.type === "thread.deleted"
            ) {
              return yield* new BridgeError({
                code: "queue_cancelled",
                message: "The session was stopped or deleted. The queued message was not sent.",
              });
            }
            if (current !== undefined) {
              const reduced = applyThreadDetailEvent(current, item.event);
              if (reduced.kind === "updated") current = reduced.thread;
            }
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          if (current !== undefined && threadState(current, now) === "interrupted") {
            return yield* new BridgeError({
              code: "queue_cancelled",
              message: "The session was interrupted. The queued message was not sent.",
            });
          }
          return { thread: current, now };
        }),
      ),
      Stream.filter(
        (item): item is { thread: OrchestrationThread; now: string } =>
          item.thread !== undefined && ready(item.thread, item.now),
      ),
      Stream.map((item) => item.thread),
      Stream.take(1),
      Stream.runCollect,
      Effect.flatMap((threads) =>
        threads[0] === undefined
          ? Effect.fail(
              new BridgeError({
                message: "The session subscription ended before the queued message could be sent.",
              }),
            )
          : Effect.succeed(threads[0]),
      ),
    );
  });
