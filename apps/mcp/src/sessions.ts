import {
  EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationThreadSearchMatch,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";

import { selectedReasoningEffort } from "./agents.ts";
import { sessionState, turnTimes } from "./status.ts";

/** Letters and digits in any script, so spoken fragments and CJK titles both match. */
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

/** A thread as list_sessions reports it. */
export function presentSession(
  serverId: string,
  source: OrchestrationV2ThreadShell,
  projectName: string,
) {
  const thread = presentThreadShell(EnvironmentId.make(serverId), source);
  return {
    server_id: serverId,
    session_id: thread.id,
    project_id: thread.projectId,
    project_name: projectName,
    title: thread.title,
    agent: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    reasoning_effort: selectedReasoningEffort(thread.modelSelection),
    state: sessionState({
      runtime: thread.runtime,
      latestRun: thread.latestRun,
      waiting: thread.hasPendingApprovals || thread.hasPendingUserInput,
    }),
    ...sessionMarks(thread),
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    turn: turnTimes(thread.latestRun),
  };
}

/** How the user has filed a session in T3 Code's sidebar. The server clears a snooze when it wakes. */
export const sessionMarks = (thread: {
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly pinnedAt: string | null;
  readonly snoozedUntil: string | null;
}) => ({
  settled: thread.settledOverride === "settled",
  pinned: thread.pinnedAt !== null,
  snoozed_until: thread.snoozedUntil,
  archived: thread.archivedAt !== null,
});

/** Where a query matched: the title, or a message the server's search found. */
export type SessionMatch =
  | { readonly in: "title" }
  | { readonly in: "user_message" | "assistant_message"; readonly snippet: string };

/**
 * Sessions, most recently updated first. A query matches when every word is in
 * the title or the server's message search matched the session. Subagent
 * threads belong to their parent session, as in T3 Code's sidebar.
 */
export function findSessions(
  sources: ReadonlyArray<{
    readonly serverId: string;
    readonly shell: {
      readonly projects: ReadonlyArray<OrchestrationProjectShell>;
      readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
    };
    /** Message search results; their threads may be older settled ones the shell omits. */
    readonly search?: {
      readonly matches: ReadonlyArray<OrchestrationThreadSearchMatch>;
      readonly threads?: ReadonlyArray<OrchestrationV2ThreadShell> | undefined;
    };
  }>,
  filter: {
    readonly projectId?: string | undefined;
    readonly query?: string | undefined;
    readonly limit: number;
  },
) {
  const wanted = words(filter.query ?? "");
  const matches = sources
    .flatMap(({ serverId, shell, search }) => {
      const projectNames = new Map(shell.projects.map((project) => [project.id, project.title]));
      const messageMatches = new Map<string, SessionMatch>();
      for (const match of search?.matches ?? []) {
        if (messageMatches.has(match.threadId)) continue;
        messageMatches.set(match.threadId, {
          in: match.source === "user" ? "user_message" : "assistant_message",
          snippet: match.snippet,
        });
      }
      const threads = new Map(shell.threads.map((thread) => [thread.id, thread]));
      for (const thread of search?.threads ?? []) {
        if (messageMatches.has(thread.id) && !threads.has(thread.id))
          threads.set(thread.id, thread);
      }
      return [...threads.values()]
        .filter((thread) => thread.lineage.relationshipToParent !== "subagent")
        .filter((thread) => filter.projectId === undefined || thread.projectId === filter.projectId)
        .flatMap((source) => {
          const title = source.title.toLowerCase();
          const match: SessionMatch | undefined =
            wanted.length === 0
              ? undefined
              : wanted.every((word) => title.includes(word))
                ? { in: "title" }
                : messageMatches.get(source.id);
          if (wanted.length > 0 && match === undefined) return [];
          return [
            {
              ...presentSession(
                serverId,
                source,
                projectNames.get(source.projectId) ?? source.projectId,
              ),
              ...(match === undefined ? {} : { match }),
            },
          ];
        });
    })
    .toSorted((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  const sessions = matches.slice(0, filter.limit);
  return { sessions, more_sessions: matches.length - sessions.length };
}
