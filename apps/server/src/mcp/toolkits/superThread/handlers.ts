import { type EnvironmentId, OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { recordLaunchedMember } from "../../../superThread/superThreadMembers.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { type Caller, dispatchFailure, newCommandId, readCaller } from "../../threadAccess.ts";
import { SuperThreadToolkit } from "./tools.ts";

/** Records a thread `t3_thread_launch` is about to start here, before the launch dispatches. */
export const recordLocalLaunch = Effect.fn("SuperThreadMcp.recordLocalLaunch")(function* (
  { scope, threads, caller }: Caller,
  threadId: ThreadId,
) {
  yield* recordLaunchedMember(threads, caller, {
    environmentId: scope.environmentId,
    threadId,
  }).pipe(Effect.mapError(dispatchFailure));
});

/** A linked environment picks the thread id, so its launch is recorded once the result returns. */
export const recordForwardedLaunch = Effect.fn("SuperThreadMcp.recordForwardedLaunch")(function* <
  A extends { readonly threadId: ThreadId },
>(_input: unknown, environmentId: EnvironmentId, launched: A) {
  const { threads, caller } = yield* readCaller();
  yield* recordLaunchedMember(threads, caller, { environmentId, threadId: launched.threadId }).pipe(
    Effect.mapError(dispatchFailure),
  );
  return launched;
});

export const layer = McpToolAccess.toLayer(SuperThreadToolkit, {
  super_thread_board_set: McpToolAccess.actsAsCaller((board) =>
    Effect.gen(function* () {
      const { caller, threads } = yield* readCaller();
      if (caller?.superThread === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only a super thread has a goal board.",
        });
      }
      const result = yield* threads
        .dispatch({
          type: "super_thread.board.set",
          commandId: yield* newCommandId(),
          threadId: caller.id,
          board,
        })
        .pipe(Effect.mapError(dispatchFailure));
      const updatedAt = result.storedEvents.flatMap(({ event }) =>
        event.type === "thread.tags-updated" && event.payload.superThread?.board
          ? [event.payload.superThread.board.updatedAt]
          : [],
      )[0];
      return { updatedAt: updatedAt ?? DateTime.formatIso(yield* DateTime.now) };
    }),
  ),
});
