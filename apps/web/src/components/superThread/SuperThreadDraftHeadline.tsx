import type { DraftId } from "~/composerDraftStore";

import { InlineButton } from "../ui/button";
import { setSuperThreadDraft } from "./superThreadDrafts";

/** The empty-draft hero for a super thread, so the person knows what sending will create. */
export function SuperThreadDraftHeadline(props: { readonly draftId: DraftId }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        New super thread
      </h1>
      <p className="mt-2 flex h-6 w-full items-center justify-center gap-1.5 text-sm text-muted-foreground">
        <span className="min-w-0 truncate">
          Describe the goal. It launches threads across your projects and keeps a board.
        </span>
        <span aria-hidden>·</span>
        <InlineButton
          tone="muted"
          className="pointer-events-auto shrink-0"
          onClick={() => setSuperThreadDraft(props.draftId, false)}
        >
          Make it a normal thread
        </InlineButton>
      </p>
    </div>
  );
}
