import {
  CommandId,
  type SuperThreadLaunchKey,
  type SuperThreadMember,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Adds a thread the caller launched to its group when the caller is a super thread; any other
 * caller records nothing. The command id names the pair, so a retried launch replays the record.
 * `launch` is the pending linked launch the record answers, which it ends.
 */
export const recordLaunchedMember = Effect.fn("SuperThread.recordLaunchedMember")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "dispatch">,
  caller: { readonly id: ThreadId; readonly superThread?: unknown } | undefined,
  member: SuperThreadMember,
  launch?: SuperThreadLaunchKey,
) {
  if (caller?.superThread === undefined) return;
  yield* threads.dispatch({
    type: "super_thread.member.record",
    commandId: CommandId.make(
      `super-thread:member:${caller.id}:${member.environmentId}:${member.threadId}`,
    ),
    threadId: caller.id,
    member,
    ...(launch === undefined ? {} : { launch }),
  });
});
