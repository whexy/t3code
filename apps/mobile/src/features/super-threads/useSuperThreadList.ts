import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";

import { deriveSuperThreadList } from "./superThreadList";

type SuperThreadListInput<T extends EnvironmentThreadShell> = Parameters<
  typeof deriveSuperThreadList<T>
>[0];

/** Keeps `unclaimedThreads` stable between renders, since the thread list memoizes on it. */
export function useSuperThreadList<T extends EnvironmentThreadShell>(
  input: SuperThreadListInput<T>,
) {
  const { threads, environmentId, projectRefs, searchQuery, loadedEnvironmentIds } = input;
  return useMemo(
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
}
