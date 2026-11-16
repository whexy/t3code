import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

// Folds outlive their super threads; old ones are dropped first.
const KEPT_FOLDS = 100;

interface SuperThreadFoldState {
  /** Header thread keys of folded sections, most recently folded first. */
  readonly foldedThreadKeys: ReadonlyArray<string>;
}

const useSuperThreadFoldStore = create<SuperThreadFoldState>()(
  persist((): SuperThreadFoldState => ({ foldedThreadKeys: [] }), {
    name: "t3code:super-thread-folds:v1",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    version: 1,
    migrate: (persisted) => {
      const keys = (persisted as Partial<SuperThreadFoldState> | null)?.foldedThreadKeys;
      return {
        foldedThreadKeys: Array.isArray(keys)
          ? keys.filter((key): key is string => typeof key === "string")
          : [],
      };
    },
  }),
);

export function useFoldedSuperThreadKeys(): ReadonlyArray<string> {
  return useSuperThreadFoldStore((state) => state.foldedThreadKeys);
}

export function toggleSuperThreadFold(threadKey: string) {
  useSuperThreadFoldStore.setState(({ foldedThreadKeys }) => ({
    foldedThreadKeys: foldedThreadKeys.includes(threadKey)
      ? foldedThreadKeys.filter((key) => key !== threadKey)
      : [threadKey, ...foldedThreadKeys].slice(0, KEPT_FOLDS),
  }));
}
