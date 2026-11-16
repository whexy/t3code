import { type EnvironmentId, OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
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

const notSuperThread = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Only a super thread has a task map.",
  });

export const layer = McpToolAccess.toLayer(SuperThreadToolkit, {
  super_thread_map_update: McpToolAccess.actsAsCaller((update) =>
    Effect.gen(function* () {
      const { caller, threads } = yield* readCaller();
      if (caller?.superThread === undefined) return yield* notSuperThread();
      const result = yield* threads
        .dispatch({
          type: "super_thread.map.update",
          commandId: yield* newCommandId(),
          threadId: caller.id,
          update,
        })
        .pipe(Effect.mapError(dispatchFailure));
      const map = result.storedEvents.flatMap(({ event }) =>
        event.type === "thread.tags-updated" && event.payload.superThread?.map
          ? [event.payload.superThread.map]
          : [],
      )[0];
      return {
        revision: map?.revision ?? 0,
        nodeCount: map?.nodes.length ?? 0,
        edgeCount: map?.edges.length ?? 0,
      };
    }),
  ),
  super_thread_map_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { caller, threads } = yield* readCaller();
      if (caller?.superThread === undefined) return yield* notSuperThread();
      // The caller is a shell, which leaves the map out.
      const { thread } = yield* threads
        .getThreadRecords(caller.id, [])
        .pipe(Effect.mapError(dispatchFailure));
      return { map: thread.superThread?.map ?? null };
    }),
  ),
});
