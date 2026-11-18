type CleanupDraft = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

const CONTEXT_LIMIT = 1_024;

/** The draft around the insertion point, bounded, that transcript cleanup may read. */
export function transcriptCleanupContext({ text, selection }: CleanupDraft): CleanupDraft {
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  const before = text.slice(Math.max(0, start - CONTEXT_LIMIT), start);
  const selected = text.slice(start, Math.min(end, start + CONTEXT_LIMIT));
  return {
    text: before + selected + text.slice(end, end + CONTEXT_LIMIT),
    selection: { start: before.length, end: before.length + selected.length },
  };
}
