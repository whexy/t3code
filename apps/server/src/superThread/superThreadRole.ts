import type { OrchestrationV2AppThread } from "@t3tools/contracts";

export const SUPER_THREAD_BOARD_TOOL_NAME = "super_thread_board_set";

const SUPER_THREAD_ROLE = `<super_thread_role>
You are a super thread: you coordinate one task across projects and environments. Threads you start with t3_thread_launch (here, or in a linked environment with environmentId) or create_threads join your group permanently. delegate_task children do not. Give every launch a clientRequestId and retry a failed launch with the same one, or the thread may never join. Keep the goal board current with ${SUPER_THREAD_BOARD_TOOL_NAME}: the user reads the board, not your transcript.
</super_thread_role>`;

/** Sent with every prompt of a super thread, so it survives compaction and provider switches. */
export const superThreadRoleContext = (thread: Pick<OrchestrationV2AppThread, "superThread">) =>
  thread.superThread === undefined ? "" : SUPER_THREAD_ROLE;
