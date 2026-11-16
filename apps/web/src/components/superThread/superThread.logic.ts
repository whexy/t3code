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
