import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { BridgeError } from "./errors.ts";
import { threadState, type SessionState } from "./status.ts";

/**
 * The first projection, from the subscription's snapshot and replayed events,
 * that is `ready`. With `withinMs`, waiting stops after that long and the
 * latest projection comes back with `settled: false`.
 */
export const waitForThreadState = <E, R>(
  updates: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>,
  ready: (projection: OrchestrationV2ThreadProjection) => boolean,
  withinMs?: number,
) =>
  Effect.suspend(() => {
    let current: OrchestrationV2ThreadProjection | null = null;
    const settled = updates.pipe(
      Stream.map((item) => {
        if (item.kind === "snapshot") current = item.projection;
        if (item.kind === "event")
          current = applyOrchestrationV2ProjectionEvent(current, item.event);
        return current;
      }),
      Stream.filter(
        (projection): projection is OrchestrationV2ThreadProjection =>
          projection !== null && ready(projection),
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new BridgeError({
                message: "The session subscription ended before the session was ready.",
              }),
            ),
          onSome: (projection) => Effect.succeed({ projection, settled: true }),
        }),
      ),
    );
    if (withinMs === undefined) return settled;
    return settled.pipe(
      Effect.timeoutOption(withinMs),
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            current === null
              ? Effect.fail(
                  new BridgeError({
                    message: "The session subscription sent no snapshot in time.",
                  }),
                )
              : Effect.succeed({ projection: current, settled: false }),
        }),
      ),
    );
  });

/**
 * Runs doing work, or due to start it without anyone acting; a held queue waits for resume_queue.
 * A waiting run that needs the user ends the wait through its state, not here.
 */
const WORKING_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const isWorking = (run: OrchestrationV2Run) =>
  WORKING_RUN_STATUSES.has(run.status) && run.queueHeld !== true;
const WORKING_STATES = new Set<SessionState>(["queued", "starting", "running"]);

export const workingRunIds = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.filter(isWorking).map((run) => run.id);

/**
 * What a wait is for: the work underway when it began has ended, or the agent
 * needs the user. Watching those runs, not only the state, ends the wait with
 * the turn even when a message queued later starts right after it. `watched`
 * fixes those runs up front, for a wait that resumes after a restart.
 */
export function turnEnded(watched?: ReadonlyArray<string>) {
  let started = watched === undefined ? undefined : new Set(watched);
  return (projection: OrchestrationV2ThreadProjection) => {
    started ??= new Set(workingRunIds(projection));
    if (!WORKING_STATES.has(threadState(projection))) return true;
    const pending = started;
    return (
      pending.size > 0 && !projection.runs.some((run) => pending.has(run.id) && isWorking(run))
    );
  };
}
