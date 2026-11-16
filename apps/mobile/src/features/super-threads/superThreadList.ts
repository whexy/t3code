import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  deriveSuperThreadSections,
  type SuperThreadSection,
} from "@t3tools/client-runtime/state/super-threads";
import { isListedThreadLineage, type EnvironmentId, type ProjectId } from "@t3tools/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { resolveThreadListV2Status, type ThreadListV2Status } from "../threads/threadListV2";

const NO_SECTIONS: ReadonlyArray<SuperThreadSection<never>> = [];

/**
 * The thread list's super thread sections, derived only from threads the list itself would show
 * in its scope, so a filter never brings a hidden thread back. Threads of an environment whose
 * config has not loaded stay in the normal list, as it cannot tell yet whether they are settled.
 * A search lists matches flat, so it shows no sections.
 */
export function deriveSuperThreadList<T extends EnvironmentThreadShell>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs:
    | ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }>
    | null
    | undefined;
  readonly searchQuery: string;
  readonly loadedEnvironmentIds: ReadonlySet<EnvironmentId>;
}): {
  readonly sections: ReadonlyArray<SuperThreadSection<T>>;
  readonly unclaimedThreads: ReadonlyArray<T>;
} {
  const { threads } = input;
  if (
    input.searchQuery.trim().length > 0 ||
    !threads.some((thread) => thread.source.superThread !== undefined)
  ) {
    return { sections: NO_SECTIONS, unclaimedThreads: threads };
  }
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;
  const eligible = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      isListedThreadLineage(thread.lineage) &&
      input.loadedEnvironmentIds.has(thread.environmentId) &&
      (input.environmentId === null || thread.environmentId === input.environmentId) &&
      (projectKeys === null || projectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
  const { sections, claimedThreadKeys } = deriveSuperThreadSections(eligible);
  return {
    sections,
    unclaimedThreads:
      claimedThreadKeys.size === 0
        ? threads
        : threads.filter(
            (thread) => !claimedThreadKeys.has(scopedThreadKey(thread.environmentId, thread.id)),
          ),
  };
}

const ROLLUP_ORDER = [
  "approval",
  "input",
  "request",
  "failed",
  "limited",
  "working",
  "waiting",
] as const satisfies ReadonlyArray<ThreadListV2Status>;

export type SuperThreadRollup = (typeof ROLLUP_ORDER)[number] | "done" | null;

/**
 * A super thread row's status over the whole group: the most urgent status among the super thread
 * and its unsettled members, and Done only once every one of them has finished its latest run.
 */
export function resolveSuperThreadRollup(
  header: EnvironmentThreadShell,
  rows: ReadonlyArray<EnvironmentThreadShell>,
): SuperThreadRollup {
  const threads = [header, ...rows];
  const statuses = new Set(threads.map(resolveThreadListV2Status));
  const urgent = ROLLUP_ORDER.find((status) => statuses.has(status));
  if (urgent !== undefined) return urgent;
  return threads.every((thread) => thread.latestRun?.status === "completed") ? "done" : null;
}
