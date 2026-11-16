import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  deriveSuperThreadSections,
  type SuperThreadSection,
  type SuperThreadSettleWarning,
} from "@t3tools/client-runtime/state/super-threads";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SuperThreadBoardItem,
  SuperThreadBoardItemStatus,
} from "@t3tools/contracts";

import { filterSidebarV2VisibleThreads, resolveSidebarThreadStatus } from "../Sidebar.logic";

const NO_SECTIONS: ReadonlyArray<SuperThreadSection<EnvironmentThreadShell>> = [];

/**
 * The sidebar's super thread sections, derived only from threads the sidebar itself would list,
 * so a scope or lineage filter never brings a hidden thread back. Threads of an environment whose
 * config has not loaded are left out, as the sidebar cannot tell yet whether they are settled.
 */
export function deriveSuperThreadSidebar(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
}) {
  const { threads, scopedProjectKeys, delegatedUnderParent, serverConfigs } = input;
  if (!threads.some((thread) => thread.source.superThread !== undefined)) {
    return { sections: NO_SECTIONS, unclaimedThreads: threads };
  }
  const eligible = filterSidebarV2VisibleThreads(
    threads,
    scopedProjectKeys,
    delegatedUnderParent,
  ).filter((thread) => serverConfigs.has(thread.environmentId));
  const { sections, claimedThreadKeys } = deriveSuperThreadSections(eligible);
  return {
    sections,
    unclaimedThreads:
      claimedThreadKeys.size === 0
        ? threads
        : threads.filter(
            (thread) =>
              !claimedThreadKeys.has(
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
              ),
          ),
  };
}

export type SuperThreadRowStatus =
  | "working"
  | "waiting"
  | "approval"
  | "input"
  | "request"
  | "failed"
  | "done"
  | null;

/** The sidebar's status words, minus unread and wake tracking, which a section row does not show. */
export function resolveSuperThreadRowStatus(thread: EnvironmentThreadShell): SuperThreadRowStatus {
  const status = resolveSidebarThreadStatus(thread);
  switch (status) {
    case "preparing":
    case "working":
      return "working";
    case "limited":
      return "failed";
    case "ready":
      return thread.latestRun === null ? null : "done";
    default:
      return status;
  }
}

export const SUPER_THREAD_BOARD_COLUMNS: ReadonlyArray<{
  readonly status: SuperThreadBoardItemStatus;
  readonly label: string;
}> = [
  { status: "todo", label: "To do" },
  { status: "doing", label: "Doing" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

export function groupSuperThreadBoardItems(
  items: ReadonlyArray<SuperThreadBoardItem>,
): Record<SuperThreadBoardItemStatus, ReadonlyArray<SuperThreadBoardItem>> {
  const columns: Record<SuperThreadBoardItemStatus, SuperThreadBoardItem[]> = {
    todo: [],
    doing: [],
    blocked: [],
    done: [],
  };
  for (const item of items) columns[item.status].push(item);
  return columns;
}

const LISTED_TITLES = 5;

function titleList(titles: ReadonlyArray<string>): string {
  const shown = titles.slice(0, LISTED_TITLES).map((title) => `"${title}"`);
  const rest = titles.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** The confirmation for settling a super thread, or null when nothing needs the person's attention. */
export function buildSuperThreadSettleConfirmation(input: {
  readonly title: string;
  readonly warnings: ReadonlyArray<SuperThreadSettleWarning>;
  readonly memberSettleCount: number;
  readonly titleOf: (ref: ScopedThreadRef) => string | null;
}): string | null {
  if (input.warnings.length === 0) return null;
  const titlesFor = (reason: SuperThreadSettleWarning["reason"]) =>
    input.warnings
      .filter((warning) => warning.reason === reason)
      .map((warning) => input.titleOf(warning.ref) ?? "Untitled thread");
  const running = titlesFor("running");
  const needsInput = titlesFor("needs-input");
  const unreachable = input.warnings.filter((warning) => warning.reason === "unreachable").length;
  const threads = (count: number) => `${count} thread${count === 1 ? "" : "s"}`;
  const lines = [
    input.memberSettleCount > 0
      ? `Settle "${input.title}" and ${threads(input.memberSettleCount)} it launched?`
      : `Settle "${input.title}"?`,
  ];
  if (running.length > 0) lines.push(`Still working: ${titleList(running)}.`);
  if (needsInput.length > 0) {
    lines.push(
      `Waiting for you: ${titleList(needsInput)}. Settling can dismiss their open questions.`,
    );
  }
  if (unreachable > 0) {
    lines.push(`${threads(unreachable)} can't be reached right now and won't be settled.`);
  }
  return lines.join("\n");
}
