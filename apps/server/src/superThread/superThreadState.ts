import type {
  OrchestrationV2AppThread,
  OrchestrationV2ThreadShell,
  SuperThreadInternalCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/** The thread a super thread command leaves, or why it refuses. */
export function applySuperThreadCommand(
  thread: OrchestrationV2AppThread,
  command: SuperThreadInternalCommand,
  now: DateTime.Utc,
): OrchestrationV2AppThread | { readonly refused: string } {
  const state = thread.superThread;
  if (state === undefined) return { refused: `Thread ${thread.id} is not a super thread.` };
  if (thread.deletedAt !== null) return { refused: `Thread ${thread.id} is deleted.` };
  switch (command.type) {
    case "super_thread.member.record": {
      const { environmentId, threadId } = command.member;
      if (
        state.members.some(
          (member) => member.environmentId === environmentId && member.threadId === threadId,
        )
      ) {
        return thread;
      }
      return { ...thread, superThread: { ...state, members: [...state.members, command.member] } };
    }
    case "super_thread.board.set":
      return {
        ...thread,
        superThread: { ...state, board: { ...command.board, updatedAt: DateTime.formatIso(now) } },
      };
  }
}

/**
 * `thread.tags-updated` replaces the thread record without counting as activity or alerting, and
 * every client already decodes it; a new event type would break clients older than this server.
 */
export const superThreadUpdatedEvent = (
  thread: OrchestrationV2AppThread,
  occurredAt: DateTime.Utc,
) => ({
  type: "thread.tags-updated" as const,
  threadId: thread.id,
  providerInstanceId: thread.providerInstanceId,
  occurredAt,
  payload: thread,
});

/** The shell streams on every thread change, so it leaves the board to thread detail. */
export const superThreadShellFields = (
  thread: OrchestrationV2AppThread,
): Pick<OrchestrationV2ThreadShell, "superThread"> =>
  thread.superThread === undefined ? {} : { superThread: { members: thread.superThread.members } };

/** Whether a thread's MCP session should see the super thread tools; a failed read hides them. */
export const isSuperThread = <E, R>(
  projectionStore: {
    readonly getThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread, E, R>;
  },
  threadId: ThreadId,
) =>
  projectionStore.getThread(threadId).pipe(
    Effect.map((thread) => thread.superThread !== undefined),
    Effect.orElseSucceed(() => false),
  );
