import { useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";

import { writeFileAtomically } from "../../lib/atomic-file";
import { SerializedAsyncQueue } from "../../lib/serialized-async-queue";
import { appAtomRegistry } from "../../state/atom-registry";

/**
 * Header thread keys of folded super thread sections, most recently folded first. Kept in its own
 * file so the fork never edits the preferences schema.
 */
const SuperThreadFolds = Schema.Array(Schema.String);

// Folds outlive their super threads; old ones are dropped first.
const KEPT = 100;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(SuperThreadFolds));

const foldsAtom = Atom.make<ReadonlyArray<string> | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:super-thread-folds"),
);
const writes = new SerializedAsyncQueue();
let loading: Promise<ReadonlyArray<string>> | null = null;

async function foldsFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, "super-thread-folds.json");
}

function load(): Promise<ReadonlyArray<string>> {
  const current = appAtomRegistry.get(foldsAtom);
  if (current !== null) return Promise.resolve(current);
  loading ??= (async () => {
    let stored: ReadonlyArray<string> = [];
    try {
      const file = await foldsFile();
      if (file.exists) stored = decode(await file.text());
    } catch {}
    // A fold made while the file was being read is newer than the file.
    const raced = appAtomRegistry.get(foldsAtom);
    if (raced !== null) return raced;
    appAtomRegistry.set(foldsAtom, stored);
    return stored;
  })();
  return loading;
}

export async function toggleSuperThreadFold(threadKey: string): Promise<void> {
  await load();
  const current = appAtomRegistry.get(foldsAtom) ?? [];
  const next = current.includes(threadKey)
    ? current.filter((key) => key !== threadKey)
    : [threadKey, ...current].slice(0, KEPT);
  appAtomRegistry.set(foldsAtom, next);
  await writes.run(async () => {
    try {
      await writeFileAtomically(await foldsFile(), JSON.stringify(next));
    } catch {}
  });
}

const loadedFoldsAtom = Atom.make((get) => {
  const folds = get(foldsAtom);
  if (folds === null) void load();
  return folds ?? [];
}).pipe(Atom.withLabel("mobile:super-thread-folds-loaded"));

export function useFoldedSuperThreadKeys(): ReadonlyArray<string> {
  return useAtomValue(loadedFoldsAtom);
}
