import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { freshSideChats } from "./freshSideChats";

export function useDiscardAbandonedSideChat(ref: ScopedThreadRef | null) {
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const discard = useEffectEvent((target: ScopedThreadRef) => {
    void deleteThread({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, onlyIfUnused: true },
    });
  });
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- deletes a server thread when the last screen showing it goes away
  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    const key = scopedThreadKey(environmentId, threadId);
    freshSideChats.enter(key);
    return () => {
      freshSideChats.leave(key);
      // Waits a tick so a screen that replaces this one, such as maximizing it, enters first.
      setTimeout(() => {
        const draft = getComposerDraftSnapshot(key);
        if (draft.text.trim().length > 0 || draft.attachments.length > 0) return;
        if (!freshSideChats.takeAbandoned(key)) return;
        discard({ environmentId, threadId });
      }, 0);
    };
  }, [environmentId, threadId]);
}
