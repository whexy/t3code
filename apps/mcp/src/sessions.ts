import { EnvironmentId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";

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
 * test". Shells leave out archived sessions; subagent threads belong to their
 * parent session, as in T3 Code's sidebar.
 */
export function findSessions(
  shells: ReadonlyArray<{
    readonly serverId: string;
    readonly shell: OrchestrationV2ShellSnapshot;
  }>,
  filter: {
    readonly projectId?: string | undefined;
    readonly query?: string | undefined;
    readonly limit: number;
  },
) {
  const wanted = words(filter.query ?? "");
  const matches = shells
    .flatMap(({ serverId, shell }) => {
      const projectNames = new Map(shell.projects.map((project) => [project.id, project.title]));
      return shell.threads
        .filter((thread) => thread.lineage.relationshipToParent !== "subagent")
        .filter((thread) => filter.projectId === undefined || thread.projectId === filter.projectId)
        .filter((thread) => {
          const title = thread.title.toLowerCase();
          return wanted.every((word) => title.includes(word));
        })
        .map((source) => {
          const thread = presentThreadShell(EnvironmentId.make(serverId), source);
          return {
            server_id: serverId,
            session_id: thread.id,
            project_id: thread.projectId,
            project_name: projectNames.get(thread.projectId) ?? thread.projectId,
            title: thread.title,
            agent: thread.modelSelection.instanceId,
            model: thread.modelSelection.model,
            reasoning_effort: selectedReasoningEffort(thread.modelSelection),
            state: sessionState({
              runtime: thread.runtime,
              latestRun: thread.latestRun,
              waiting: thread.hasPendingApprovals || thread.hasPendingUserInput,
            }),
            created_at: thread.createdAt,
            updated_at: thread.updatedAt,
            turn: turnTimes(thread.latestRun),
          };
        });
    })
    .toSorted((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  const sessions = matches.slice(0, filter.limit);
  return { sessions, more_sessions: matches.length - sessions.length };
}
