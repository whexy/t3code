import type { OrchestrationShellSnapshot } from "@t3tools/contracts";

import { selectedReasoningEffort } from "./agents.ts";
import { sessionState, turnTimes } from "./status.ts";

/** Letters and digits in any script, so spoken fragments and CJK titles both match. */
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

/**
 * Sessions on the given servers, most recently updated first. Every word of
 * `query` must appear in the title, so "flaky test" finds "Fix the flaky
 * test". Shells leave out archived sessions.
 */
export function findSessions(
  shells: ReadonlyArray<{ readonly serverId: string; readonly shell: OrchestrationShellSnapshot }>,
  filter: {
    readonly projectId?: string | undefined;
    readonly query?: string | undefined;
    readonly limit: number;
    readonly now: string;
  },
) {
  const wanted = words(filter.query ?? "");
  const matches = shells
    .flatMap(({ serverId, shell }) => {
      const projectNames = new Map(shell.projects.map((project) => [project.id, project.title]));
      return shell.threads
        .filter((thread) => filter.projectId === undefined || thread.projectId === filter.projectId)
        .filter((thread) => {
          const title = thread.title.toLowerCase();
          return wanted.every((word) => title.includes(word));
        })
        .map((thread) => ({
          server_id: serverId,
          session_id: thread.id,
          project_id: thread.projectId,
          project_name: projectNames.get(thread.projectId) ?? thread.projectId,
          title: thread.title,
          agent: thread.modelSelection.instanceId,
          model: thread.modelSelection.model,
          reasoning_effort: selectedReasoningEffort(thread.modelSelection),
          state: sessionState(
            { ...thread, waiting: thread.hasPendingApprovals || thread.hasPendingUserInput },
            filter.now,
          ),
          created_at: thread.createdAt,
          updated_at: thread.updatedAt,
          turn: turnTimes(thread.latestTurn),
        }));
    })
    .toSorted((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  const sessions = matches.slice(0, filter.limit);
  return { sessions, more_sessions: matches.length - sessions.length };
}
