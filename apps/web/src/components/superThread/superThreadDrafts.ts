import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "../../composerDraftStore";
import type { NewThreadHandler } from "../../hooks/useHandleNewThread";
import { resolveStorage } from "../../lib/storage";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projects";
import { stackedThreadToast, toastManager } from "../ui/toast";

// Drafts are short-lived, so a handful of the newest marks is all that can still be sent.
const KEPT_DRAFTS = 20;

interface SuperThreadDraftState {
  readonly draftIds: ReadonlyArray<string>;
}

// Kept apart from the composer draft store so the fork never edits that upstream schema.
const useSuperThreadDraftStore = create<SuperThreadDraftState>()(
  persist((): SuperThreadDraftState => ({ draftIds: [] }), {
    name: "t3code:super-thread-drafts:v1",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    version: 1,
    migrate: (persisted) => {
      const draftIds = (persisted as Partial<SuperThreadDraftState> | null)?.draftIds;
      return {
        draftIds: Array.isArray(draftIds)
          ? draftIds.filter((id): id is string => typeof id === "string")
          : [],
      };
    },
  }),
);

export function setSuperThreadDraft(draftId: DraftId, superThread: boolean) {
  useSuperThreadDraftStore.setState((state) => {
    const rest = state.draftIds.filter((id) => id !== draftId);
    return { draftIds: superThread ? [draftId, ...rest].slice(0, KEPT_DRAFTS) : rest };
  });
}

export function useIsSuperThreadDraft(draftId: DraftId | null | undefined): boolean {
  return useSuperThreadDraftStore((state) => draftId != null && state.draftIds.includes(draftId));
}

/** Spread into a draft's `bootstrap.createThread`, so sending a super draft creates a super thread. */
export function superThreadDraftBootstrap(draftId: DraftId | null): { superThread?: true } {
  return draftId !== null && useSuperThreadDraftStore.getState().draftIds.includes(draftId)
    ? { superThread: true }
    : {};
}

function reportStartFailure(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not start a super thread",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** Opens a draft in the scratch project that becomes a super thread when sent. */
export async function startSuperThreadDraft(
  environmentId: EnvironmentId,
  handleNewThread: NewThreadHandler,
): Promise<void> {
  const command = projectEnvironment.openScratch;
  const opened = await runAtomCommand(
    appAtomRegistry,
    command,
    { environmentId, input: {} },
    { label: command.label, reportFailure: false, reportDefect: true },
  );
  if (opened._tag !== "Success") {
    if (!isAtomCommandInterrupted(opened)) reportStartFailure(squashAtomCommandFailure(opened));
    return;
  }
  try {
    const draft = await handleNewThread(
      scopeProjectRef(opened.value.environmentId, opened.value.id),
    );
    if (draft !== null) setSuperThreadDraft(draft.draftId, true);
  } catch (error) {
    reportStartFailure(error);
  }
}
