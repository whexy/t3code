import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  deriveSuperThreadSections,
  type SuperThreadSection,
} from "@t3tools/client-runtime/state/super-threads";
import type { EnvironmentId } from "@t3tools/contracts";

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
  | "setting-up"
  | "goal"
  | "working"
  | "waiting"
  | "approval"
  | "input"
  | "request"
  | "limited"
  | "failed"
  | "done"
  | null;

/**
 * The sidebar row's status label, mirrored rather than shared so the fork leaves that upstream
 * row alone. Wake tracking is left out: a section row has no snooze controls.
 */
export function resolveSuperThreadRowStatus(
  thread: EnvironmentThreadShell,
  isUnread: boolean,
): SuperThreadRowStatus {
  const status = resolveSidebarThreadStatus(thread);
  switch (status) {
    case "preparing":
      return "setting-up";
    case "working":
      return thread.goal?.status === "active" ? "goal" : "working";
    case "ready":
      return isUnread ? "done" : null;
    default:
      return status;
  }
}

/**
 * The shell of a row shown in a super thread section, its header or a member, which the sidebar's
 * own lists leave out. Its menu has no pin or snooze: the section lists every unsettled one, so
 * those would change nothing on screen.
 */
export function findSuperThreadSectionThread(
  sections: ReadonlyArray<SuperThreadSection<EnvironmentThreadShell>>,
  threadKey: string,
): EnvironmentThreadShell | undefined {
  const keyOf = (thread: EnvironmentThreadShell) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  for (const section of sections) {
    if (keyOf(section.header) === threadKey) return section.header;
    const member = section.rows.find((row) => keyOf(row) === threadKey);
    if (member !== undefined) return member;
  }
  return undefined;
}
