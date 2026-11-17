import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

import {
  backgroundWorkHoldsCompletion,
  monitorHoldsWakeCompletion,
} from "./orchestrationV2PendingBackgroundWork.ts";

/**
 * A member reports to its super thread, which is woken for each of its outcomes, so a member
 * never alerts the user itself: the user did not brief it and has nothing to check on it.
 */
export const isSuperThreadMember = (
  thread: Pick<OrchestrationV2ThreadShell, "superThreadMemberOf">,
): boolean => thread.superThreadMemberOf != null;

export type SuperThreadMemberActivity = Pick<
  OrchestrationV2ThreadShell,
  | "activityRunStatus"
  | "status"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "latestRunBackgroundWake"
>;

/**
 * A super thread's completion while members work only pauses its task: their outcomes wake it.
 * A member works through background work that holds its own completion, as in its awareness; one
 * waiting on the user ends the hold. `followingElsewhere`: a followed run in a linked environment.
 */
export function superThreadMembersHoldCompletion(
  members: Iterable<SuperThreadMemberActivity>,
  followingElsewhere = false,
): boolean {
  let working = followingElsewhere;
  for (const member of members) {
    const request = member.pendingRuntimeRequest;
    if (request != null && request.kind !== "auth_refresh") return false;
    switch (member.activityRunStatus ?? member.status) {
      case "queued":
      case "preparing":
      case "starting":
      case "running":
      case "waiting":
        working = true;
        break;
      case "completed":
        if (
          backgroundWorkHoldsCompletion(member.pendingBackgroundTasks ?? []) ||
          monitorHoldsWakeCompletion(member)
        ) {
          working = true;
        }
    }
  }
  return working;
}
