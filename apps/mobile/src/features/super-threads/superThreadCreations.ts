import { useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";

import { writeFileAtomically } from "../../lib/atomic-file";
import { SerializedAsyncQueue } from "../../lib/serialized-async-queue";
import { appAtomRegistry } from "../../state/atom-registry";

/**
 * Drafts opened as super threads, and the threads they became until delivered. Kept apart from
 * the composer draft and outbox schemas so the fork never edits them. Both live on disk because a
 * draft, and a creation queued while offline, outlive the app process.
 */
const SuperThreadCreations = Schema.Struct({
  draftKeys: Schema.Array(Schema.String),
  threadIds: Schema.Array(Schema.String),
});
type SuperThreadCreations = typeof SuperThreadCreations.Type;

// Drafts and queued creations are short-lived, so a handful of the newest marks is enough.
const KEPT = 20;
const EMPTY: SuperThreadCreations = { draftKeys: [], threadIds: [] };
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(SuperThreadCreations));

const creationsAtom = Atom.make<SuperThreadCreations | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:super-thread-creations"),
);
const writes = new SerializedAsyncQueue();
let loading: Promise<SuperThreadCreations> | null = null;

async function creationsFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, "super-thread-creations.json");
}

function load(): Promise<SuperThreadCreations> {
  const current = appAtomRegistry.get(creationsAtom);
  if (current !== null) return Promise.resolve(current);
  loading ??= (async () => {
    let stored = EMPTY;
    try {
      const file = await creationsFile();
      if (file.exists) stored = decode(await file.text());
    } catch {}
    // A mark written while the file was being read is newer than the file.
    const raced = appAtomRegistry.get(creationsAtom);
    if (raced !== null) return raced;
    appAtomRegistry.set(creationsAtom, stored);
    return stored;
  })();
  return loading;
}

async function update(change: (current: SuperThreadCreations) => SuperThreadCreations) {
  await load();
  const next = change(appAtomRegistry.get(creationsAtom) ?? EMPTY);
  appAtomRegistry.set(creationsAtom, next);
  await writes.run(async () => {
    try {
      await writeFileAtomically(await creationsFile(), JSON.stringify(next));
    } catch {}
  });
}

const prepend = (list: ReadonlyArray<string>, value: string) =>
  [value, ...list.filter((entry) => entry !== value)].slice(0, KEPT);

export function markSuperThreadDraft(draftKey: string): Promise<void> {
  return update((current) => ({ ...current, draftKeys: prepend(current.draftKeys, draftKey) }));
}

/** Called before a draft's creation is queued, so delivery sees the mark. */
export async function recordSuperThreadCreation(draftKey: string, threadId: string) {
  if (!(await load()).draftKeys.includes(draftKey)) return;
  await update((current) => ({
    draftKeys: current.draftKeys.filter((entry) => entry !== draftKey),
    threadIds: prepend(current.threadIds, threadId),
  }));
}

/** Spread into a queued creation's start-turn spec, so the server creates a super thread. */
export async function superThreadCreationSpec(threadId: string): Promise<{ superThread?: true }> {
  return (await load()).threadIds.includes(threadId) ? { superThread: true } : {};
}

const draftKeysAtom = Atom.make((get) => {
  const creations = get(creationsAtom);
  if (creations === null) void load();
  return creations?.draftKeys ?? EMPTY.draftKeys;
}).pipe(Atom.withLabel("mobile:super-thread-draft-keys"));

export function useIsSuperThreadDraft(draftKey: string | null): boolean {
  const draftKeys = useAtomValue(draftKeysAtom);
  return draftKey !== null && draftKeys.includes(draftKey);
}
