import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

// Only recent super threads still have news worth marking.
const KEPT_LOOKS = 50;

type Looks = Readonly<Record<string, string>>;

interface SuperThreadPanelSeenState {
  readonly lastLookedAtByThreadKey: Looks;
}

/** Records a look at `at`, keeping only the newest looks. */
function recordSuperThreadLook(looks: Looks, threadKey: string, at: string): Looks {
  const { [threadKey]: _previous, ...rest } = looks;
  const kept = Object.entries(rest)
    .toSorted(([, left], [, right]) => right.localeCompare(left))
    .slice(0, KEPT_LOOKS - 1);
  return Object.fromEntries([[threadKey, at], ...kept]);
}

// The conversation itself moves the thread's visit mark, so the panel keeps its own.
const useSuperThreadPanelSeenStore = create<SuperThreadPanelSeenState>()(
  persist((): SuperThreadPanelSeenState => ({ lastLookedAtByThreadKey: {} }), {
    name: "t3code:super-thread-panel-seen:v1",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    version: 1,
    migrate: (persisted) => {
      const looks = (persisted as Partial<SuperThreadPanelSeenState> | null)
        ?.lastLookedAtByThreadKey;
      return {
        lastLookedAtByThreadKey:
          looks && typeof looks === "object"
            ? Object.fromEntries(
                Object.entries(looks).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              )
            : {},
      };
    },
  }),
);

function markLooked(threadKey: string) {
  useSuperThreadPanelSeenStore.setState((state) => ({
    lastLookedAtByThreadKey: recordSuperThreadLook(
      state.lastLookedAtByThreadKey,
      threadKey,
      new Date().toISOString(),
    ),
  }));
}

/**
 * When the person last looked at this super thread's panel before the current look, or
 * `undefined` for a first look. Showing the panel counts as looking until it is hidden.
 */
export function useSuperThreadPanelLook(
  threadRef: ScopedThreadRef,
  visible: boolean,
): string | undefined {
  const threadKey = scopedThreadKey(threadRef);
  // Read once per mount, before this look moves the mark.
  const [before] = useState(
    () => useSuperThreadPanelSeenStore.getState().lastLookedAtByThreadKey[threadKey],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the look in persisted storage while the panel is on screen
  useEffect(() => {
    if (!visible) return;
    markLooked(threadKey);
    return () => markLooked(threadKey);
  }, [threadKey, visible]);
  return before;
}
