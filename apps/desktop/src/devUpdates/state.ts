import type { DevBundle, DevUpdatesState } from "@t3tools/shared/devUpdates";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ManifestResponse } from "./protocol.ts";

export const StoredBundle = Schema.Struct({
  updateId: Schema.String,
  commit: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  runtimeVersion: Schema.String,
});
export type StoredBundle = typeof StoredBundle.Type;

const optionalReadableKey = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

const StoredStateDocument = Schema.Struct({
  enabled: optionalReadableKey(Schema.Boolean),
  ready: optionalReadableKey(Schema.NullOr(StoredBundle)),
  bad: optionalReadableKey(Schema.Array(Schema.String)),
});
export const StoredStateJson = Schema.fromJsonString(StoredStateDocument);

export interface StoredState {
  readonly enabled: boolean;
  // Verified on disk; the next launch serves it when the app version matches.
  readonly ready: StoredBundle | null;
  // Updates that failed to start here, newest last.
  readonly bad: ReadonlyArray<string>;
}

export const EMPTY_STATE: StoredState = { enabled: false, ready: null, bad: [] };
const MAX_BAD_UPDATES = 32;

export function fromDocument(document: typeof StoredStateDocument.Type): StoredState {
  return {
    enabled: document.enabled ?? false,
    ready: document.ready ?? null,
    bad: document.bad ?? [],
  };
}

/** The bundle this launch serves, or null for the build's own. */
export function selectLaunchBundle(state: StoredState, appVersion: string): StoredBundle | null {
  const ready = state.ready;
  if (!state.enabled || ready === null) return null;
  if (ready.runtimeVersion !== appVersion || state.bad.includes(ready.updateId)) return null;
  return ready;
}

export type CheckOutcome =
  | { readonly _tag: "Keep"; readonly state: StoredState }
  | { readonly _tag: "Download"; readonly bundle: StoredBundle };

/** What a manifest response means for the next launch, given the bundle running now. */
export function applyManifestResponse(input: {
  readonly state: StoredState;
  readonly response: ManifestResponse;
  readonly running: StoredBundle | null;
  readonly appVersion: string;
}): CheckOutcome {
  const { state, response, running } = input;
  switch (response._tag) {
    case "RollBackToEmbedded":
      return { _tag: "Keep", state: { ...state, ready: null } };
    // The request named the running bundle, so it is still the latest.
    case "NoUpdate":
      return { _tag: "Keep", state: { ...state, ready: running } };
    case "Update": {
      const { manifest } = response;
      if (manifest.runtimeVersion !== input.appVersion || state.bad.includes(manifest.id)) {
        return { _tag: "Keep", state };
      }
      const bundle: StoredBundle = {
        updateId: manifest.id,
        commit: manifest.metadata?.gitCommit ?? null,
        createdAt: manifest.createdAt,
        runtimeVersion: manifest.runtimeVersion,
      };
      if (state.ready?.updateId === manifest.id) return { _tag: "Keep", state };
      return { _tag: "Download", bundle };
    }
  }
}

export function markBad(state: StoredState, updateId: string): StoredState {
  return {
    ...state,
    ready: state.ready?.updateId === updateId ? null : state.ready,
    bad: [...state.bad.filter((id) => id !== updateId), updateId].slice(-MAX_BAD_UPDATES),
  };
}

export function setEnabled(state: StoredState, enabled: boolean): StoredState {
  return enabled ? { ...state, enabled } : { ...state, enabled, ready: null };
}

/** Bundle directories a launch or a check may still need. */
export function bundlesToKeep(
  state: StoredState,
  running: StoredBundle | null,
): ReadonlySet<string> {
  const keep = new Set<string>();
  if (running !== null) keep.add(running.updateId);
  if (state.ready !== null) keep.add(state.ready.updateId);
  return keep;
}

const toDevBundle = (bundle: StoredBundle): DevBundle => ({
  updateId: bundle.updateId,
  commit: bundle.commit,
  createdAt: bundle.createdAt,
});

export function toBridgeState(input: {
  readonly state: StoredState;
  readonly running: StoredBundle | null;
  readonly appVersion: string;
}): DevUpdatesState {
  const pending = selectLaunchBundle(input.state, input.appVersion);
  return {
    enabled: input.state.enabled,
    runtimeVersion: input.appVersion,
    running: input.running === null ? null : toDevBundle(input.running),
    pending:
      pending === null || pending.updateId === input.running?.updateId
        ? null
        : toDevBundle(pending),
  };
}
