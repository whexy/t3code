import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isListedThreadLineage } from "@t3tools/contracts";
import { useMemo } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { useOpenSuperThreadKey } from "./superThreadLevel";
import { deriveSuperThreadList } from "./superThreadList";

type SuperThreadListInput<T extends EnvironmentThreadShell> = Parameters<
  typeof deriveSuperThreadList<T>
>[0];

/**
 * Keeps `unclaimedThreads` stable between renders, since the thread list memoizes on it. `open` is
 * the section whose threads the list shows instead of its own; one that has gone closes itself.
 */
export function useSuperThreadList<T extends EnvironmentThreadShell>(
  input: SuperThreadListInput<T>,
) {
  const { threads, environmentId, projectRefs, searchQuery, loadedEnvironmentIds } = input;
  const openKey = useOpenSuperThreadKey();
  const list = useMemo(
    () =>
      deriveSuperThreadList({
        threads,
        environmentId,
        projectRefs,
        searchQuery,
        loadedEnvironmentIds,
      }),
    [threads, environmentId, projectRefs, searchQuery, loadedEnvironmentIds],
  );
  const open =
    openKey === null
      ? null
      : (list.sections.find(
          ({ header }) => scopedThreadKey(header.environmentId, header.id) === openKey,
        ) ?? null);
  // Whether the list shows any thread of its own above its shelves, under the super threads.
  const hasOwnRows = useMemo(
    () =>
      list.unclaimedThreads.some(
        (thread) =>
          thread.archivedAt === null &&
          thread.settledOverride !== "settled" &&
          isListedThreadLineage(thread.lineage),
      ),
    [list.unclaimedThreads],
  );
  return { ...list, open, hasOwnRows };
}
