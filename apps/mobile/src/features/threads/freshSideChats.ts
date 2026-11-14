import type { ScopedThreadRef } from "@t3tools/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";

/**
 * Side chats this device started empty, by thread key, with how many screens show each. Leaving
 * the last screen with an empty draft deletes the side chat, like closing its unused tab on web.
 */
export function createFreshSideChats() {
  const screens = new Map<string, number>();
  return {
    mark: (key: string) => void screens.set(key, 0),
    enter: (key: string) => {
      const count = screens.get(key);
      if (count !== undefined) screens.set(key, count + 1);
    },
    leave: (key: string) => {
      const count = screens.get(key);
      if (count !== undefined) screens.set(key, Math.max(0, count - 1));
    },
    /** True once, for a fresh side chat no screen shows any more. */
    takeAbandoned: (key: string) => {
      if (screens.get(key) !== 0) return false;
      screens.delete(key);
      return true;
    },
  };
}

export const freshSideChats = createFreshSideChats();

export const markFreshSideChat = (ref: ScopedThreadRef) =>
  freshSideChats.mark(scopedThreadKey(ref.environmentId, ref.threadId));
