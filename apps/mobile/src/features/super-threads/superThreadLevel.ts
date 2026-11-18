import { useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import { useLayoutEffect } from "react";

import { appAtomRegistry } from "../../state/atom-registry";

/**
 * The super thread whose threads the list shows in place of its own, by thread key, or null for
 * the list itself. It lasts while the app runs, not across launches.
 */
const openSuperThreadAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:open-super-thread"),
);

export function useOpenSuperThreadKey(): string | null {
  return useAtomValue(openSuperThreadAtom);
}

export function openSuperThread(threadKey: string | null): void {
  appAtomRegistry.set(openSuperThreadAtom, threadKey);
}

const openSuperThreadTitleAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:open-super-thread-title"),
);

/** The title of the super thread the list shows one level down, for the bar above the list. */
export function useOpenSuperThreadTitle(): string | null {
  return useAtomValue(openSuperThreadTitleAtom);
}

/**
 * Hands the open super thread's title to the screen's bar. Only the list knows which one it
 * shows: a super thread it can no longer find closes by derivation, without clearing the open key.
 */
export function useReportOpenSuperThreadTitle(title: string | null): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the native bar is drawn by the screen above the list, which cannot derive which super thread the list shows
  useLayoutEffect(() => {
    if (title === null) return;
    appAtomRegistry.set(openSuperThreadTitleAtom, title);
    return () => appAtomRegistry.set(openSuperThreadTitleAtom, null);
  }, [title]);
}

const NO_ITEMS: ReadonlyArray<never> = [];

/** The list's own rows, or none while it shows one super thread's threads instead. */
export function superThreadLevelItems<T>(
  list: { readonly open: unknown },
  items: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return list.open === null ? items : NO_ITEMS;
}
