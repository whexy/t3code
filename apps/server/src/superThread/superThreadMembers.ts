import {
  CommandId,
  type SuperThreadLaunchKey,
  type SuperThreadMember,
  type SuperThreadMemberRun,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/**
 * The super thread a launch makes a member for: the calling thread here, or the sender a linked
 * environment marked as one. A delegated task is that parent's subagent, not a member.
 */
export const launchingSuperThread = (
  scope: Pick<McpInvocationContext.McpInvocationScope, "environmentId" | "client">,
  caller: { readonly id: ThreadId; readonly superThread?: unknown } | undefined,
  delegated = false,
): SuperThreadMember | undefined => {
  if (delegated) return undefined;
  if (caller !== undefined) {
    return caller.superThread === undefined
      ? undefined
      : { environmentId: scope.environmentId, threadId: caller.id };
  }
  const sender = scope.client?.senderThread;
  return sender !== undefined && scope.client?.senderSuperThread === true
    ? { environmentId: sender.environmentId, threadId: sender.threadId }
    : undefined;
};

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

/**
 * Writes down a run a super thread started on its member in a linked environment, so the server
 * follows it there and its end wakes the super thread. Best effort: the launch or send already
 * happened, and without the record only its wake is missing.
 */
export const recordFollowedRun = Effect.fn("SuperThread.recordFollowedRun")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "dispatch">,
  superThreadId: ThreadId,
  run: SuperThreadMemberRun,
) {
  yield* threads
    .dispatch({
      type: "super_thread.member.follow",
      commandId: CommandId.make(
        `super-thread:follow:${superThreadId}:${run.environmentId}:${run.threadId}:${run.runId}`,
      ),
      threadId: superThreadId,
      run,
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("recording a super thread member run failed", { run, cause }),
      ),
    );
});
