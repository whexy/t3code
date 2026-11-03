import { NEW_POLICY, type OpenedText, readPolicyText, serializePolicy } from "./document.ts";
import type { PolicyFileHandle } from "./files.ts";
import { jsonEqual, setPath } from "./json.ts";
import { type RemoteLoad, type RemoteSave, sha12 } from "./remote.ts";

export interface Editing {
  readonly document: unknown;
  /** The text as opened or last saved; saving it unchanged writes these bytes back. */
  readonly opened: OpenedText | undefined;
  readonly name: string;
  readonly handle: PolicyFileHandle | undefined;
}

export const FRESH: Editing = {
  document: NEW_POLICY,
  opened: undefined,
  name: "policy.json",
  handle: undefined,
};

/** Where Save goes. */
export type Fleet =
  /** No policy server, as under `vp dev`: Save writes files. */
  | { readonly mode: "files" }
  | { readonly mode: "loading" }
  /** The fleet policy did not load, so Save cannot know what it would replace. */
  | { readonly mode: "failed" }
  | {
      readonly mode: "ready";
      /** The saved version this edit replaces; null before the first save. */
      readonly etag: string | null;
      readonly savedAt: Date | undefined;
      /** The saved version is not a policy the editor can open, so Save must ask first. */
      readonly unreadable: boolean;
    };

export interface Notice {
  readonly tone: "error" | "info";
  readonly text: string;
}

export interface Session {
  readonly editing: Editing;
  readonly fleet: Fleet;
  readonly notice: Notice | undefined;
  /** A load or save is in flight; the next one waits for it. */
  readonly busy: boolean;
}

export const INITIAL_SESSION: Session = {
  editing: FRESH,
  fleet: { mode: "loading" },
  notice: undefined,
  busy: true,
};

export type SessionAction =
  | { readonly type: "edit"; readonly segments: ReadonlyArray<string>; readonly value: unknown }
  | { readonly type: "replace"; readonly editing: Editing; readonly notice: Notice | undefined }
  | { readonly type: "notice"; readonly notice: Notice | undefined }
  | { readonly type: "begin" }
  | { readonly type: "loaded"; readonly load: RemoteLoad }
  | {
      readonly type: "saved";
      /** What the save sent, which edits made while it was in flight are not part of. */
      readonly submitted: OpenedText;
      readonly notice: Notice;
      readonly fleet?: { readonly etag: string; readonly savedAt: Date };
      readonly file?: { readonly name: string; readonly handle: PolicyFileHandle | undefined };
    }
  /** A load or save ended without changing what is being edited; no notice keeps the current one. */
  | { readonly type: "settled"; readonly notice?: Notice };

export const textOf = (editing: Editing) => serializePolicy(editing.document, editing.opened);

export function isDirty(editing: Editing, text = textOf(editing)): boolean {
  return editing.opened === undefined
    ? !jsonEqual(editing.document, NEW_POLICY)
    : text !== editing.opened.text;
}

export function afterRemoteSave(submitted: OpenedText, result: RemoteSave): SessionAction {
  switch (result.status) {
    case "saved":
      return {
        type: "saved",
        submitted,
        fleet: { etag: result.etag, savedAt: result.savedAt },
        notice: {
          tone: "info",
          text: `Saved the fleet policy (${sha12(result.etag)}). Each server applies it the next time it starts.`,
        },
      };
    case "conflict":
      return {
        type: "settled",
        notice: {
          tone: "error",
          text: "The fleet policy changed elsewhere since you loaded it, so this save was refused. Reload to get the current version.",
        },
      };
    case "error":
      return {
        type: "settled",
        notice: { tone: "error", text: `Could not save: ${result.message}` },
      };
  }
}

/** Messages come from servers and parsers, with or without a final period. */
const sentence = (message: string) => `${message.replace(/[.\s]+$/, "")}.`;

function loaded(state: Session, load: RemoteLoad): Session {
  switch (load.status) {
    case "absent":
      return { ...state, fleet: { mode: "files" } };
    case "failed":
      // A failed reload leaves the version being edited, and its ETag, as they were.
      return state.fleet.mode === "ready"
        ? {
            ...state,
            notice: {
              tone: "error",
              text: `Could not reload the fleet policy: ${sentence(load.message)}`,
            },
          }
        : {
            ...state,
            fleet: { mode: "failed" },
            notice: {
              tone: "error",
              text: `Could not load the fleet policy: ${sentence(load.message)} Retry before saving.`,
            },
          };
    case "empty":
      return {
        ...state,
        editing: FRESH,
        fleet: { mode: "ready", etag: null, savedAt: undefined, unreadable: false },
        notice: {
          tone: "info",
          text: "No fleet policy has been saved yet. Save publishes this one.",
        },
      };
    case "saved": {
      const read = readPolicyText(load.text);
      if (!read.ok) {
        return {
          ...state,
          editing: FRESH,
          fleet: { mode: "ready", etag: load.etag, savedAt: load.savedAt, unreadable: true },
          notice: {
            tone: "error",
            text: `The saved fleet policy (${sha12(load.etag)}) cannot be opened: ${sentence(read.message)} This is a new policy; Save asks before replacing the saved one.`,
          },
        };
      }
      return {
        ...state,
        editing: {
          document: read.document,
          opened: { text: load.text, document: read.document },
          name: "policy.json",
          handle: undefined,
        },
        fleet: { mode: "ready", etag: load.etag, savedAt: load.savedAt, unreadable: false },
        notice: { tone: "info", text: `Loaded the fleet policy (${sha12(load.etag)}).` },
      };
    }
  }
}

export function sessionReducer(state: Session, action: SessionAction): Session {
  switch (action.type) {
    case "edit":
      // The first load replaces the whole document, so the editor is read-only until it settles.
      if (state.fleet.mode === "loading") return state;
      return {
        ...state,
        editing: {
          ...state.editing,
          document: setPath(state.editing.document, action.segments, action.value),
        },
      };
    case "replace":
      return { ...state, editing: action.editing, notice: action.notice };
    case "notice":
      return { ...state, notice: action.notice };
    case "begin":
      return { ...state, busy: true };
    case "loaded":
      return { ...loaded(state, action.load), busy: false };
    case "saved":
      return {
        ...state,
        busy: false,
        editing: { ...state.editing, ...action.file, opened: action.submitted },
        fleet:
          action.fleet === undefined
            ? state.fleet
            : { mode: "ready", ...action.fleet, unreadable: false },
        notice: action.notice,
      };
    case "settled":
      return { ...state, busy: false, notice: action.notice ?? state.notice };
  }
}
