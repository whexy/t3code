import { useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";

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

const NO_ITEMS: ReadonlyArray<never> = [];

/** The list's own rows, or none while it shows one super thread's threads instead. */
export function superThreadLevelItems<T>(
  list: { readonly open: unknown },
  items: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return list.open === null ? items : NO_ITEMS;
}
