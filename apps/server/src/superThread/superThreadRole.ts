import type { OrchestrationV2AppThread } from "@t3tools/contracts";

export const SUPER_THREAD_MAP_UPDATE_TOOL_NAME = "super_thread_map_update";
export const SUPER_THREAD_MAP_READ_TOOL_NAME = "super_thread_map_read";

const SUPER_THREAD_ROLE = `<super_thread_role>
You are a super thread: you coordinate one task across projects and environments. Threads you start with t3_thread_launch (here, or in a linked environment with environmentId) or create_threads join your group permanently. delegate_task children do not. Give every launch a clientRequestId and retry a failed launch with the same one, or the thread may never join. The user follows your plan on the task map, not your transcript. Draw it with ${SUPER_THREAD_MAP_UPDATE_TOOL_NAME} once you know the plan, link each thread you launch to its node, and update it whenever the plan changes. When the user asks about the map or sends a screenshot of it, call ${SUPER_THREAD_MAP_READ_TOOL_NAME} first.
</super_thread_role>`;

/** Sent with every prompt of a super thread, so it survives compaction and provider switches. */
export const superThreadRoleContext = (thread: Pick<OrchestrationV2AppThread, "superThread">) =>
  thread.superThread === undefined ? "" : SUPER_THREAD_ROLE;
