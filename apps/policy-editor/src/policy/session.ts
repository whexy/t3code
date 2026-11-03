import { NEW_POLICY, type OpenedText, readPolicyText, serializePolicy } from "./document.ts";
import type { PolicyFileHandle } from "./files.ts";
import { jsonEqual, setPath } from "./json.ts";
import { type Opened, type PolicySummary, type RemoteSave, sha12 } from "./remote.ts";

export interface Editing {
  readonly document: unknown;
  /** The text as opened or last saved; saving it unchanged writes these bytes back. */
  readonly opened: OpenedText | undefined;
  /**
   * The text stored where Save writes, when known. Import changes `opened`, the layout to keep,
   * but not this, so an imported policy stays unsaved until Save.
   */
  readonly saved: string | undefined;
  /** The file name Download and file saves use. */
  readonly name: string;
  readonly handle: PolicyFileHandle | undefined;
}

export const FRESH: Editing = {
  document: NEW_POLICY,
  opened: undefined,
  saved: undefined,
  name: "policy.json",
  handle: undefined,
};

/** The stored policy Save writes to. */
export interface Target {
  readonly name: string;
  /** The saved version this edit replaces; null until the policy is first saved. */
  readonly etag: string | null;
  readonly savedAt: Date | undefined;
  /** The saved version is not a policy the editor can open, so Save must ask first. */
  readonly unreadable: boolean;
}

/** Where Save goes. */
export type Fleet =
  /** No policy server, as under `vp dev`: Save writes files. */
  | { readonly mode: "files" }
  | { readonly mode: "loading" }
  /** The policies did not load, so Save cannot know what it would replace. */
  | { readonly mode: "failed" }
  | {
      readonly mode: "ready";
      readonly policies: ReadonlyArray<PolicySummary>;
      /** None while nothing is stored yet; Save then asks for a name. */
      readonly target: Target | undefined;
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
  /** The task in flight replaces what is being edited, so edits would be lost. */
  readonly replacing: boolean;
}

export const INITIAL_SESSION: Session = {
  editing: FRESH,
  fleet: { mode: "loading" },
  notice: undefined,
  busy: true,
  replacing: true,
};

export type SessionAction =
  | { readonly type: "edit"; readonly segments: ReadonlyArray<string>; readonly value: unknown }
  | { readonly type: "replace"; readonly editing: Editing; readonly notice: Notice | undefined }
  | { readonly type: "notice"; readonly notice: Notice | undefined }
  | { readonly type: "begin"; readonly replacing: boolean }
  /** Open or Paste: the text replaces the document, and Save writes it where the last one went. */
  | {
      readonly type: "import";
      readonly file: {
        readonly name: string;
        readonly text: string;
        readonly handle: PolicyFileHandle | undefined;
      };
      readonly document: unknown;
      readonly notice: Notice | undefined;
    }
  | ({ readonly type: "opened"; readonly notice?: Notice } & Opened)
  /** A new policy that exists only here until Save creates it. */
  | { readonly type: "draft"; readonly name: string }
  | {
      readonly type: "saved";
      /** What the save sent, which edits made while it was in flight are not part of. */
      readonly submitted: OpenedText;
      readonly notice: Notice;
      readonly target?: { readonly name: string; readonly etag: string; readonly savedAt: Date };
      /** The list after the save, when it could be fetched. */
      readonly policies?: ReadonlyArray<PolicySummary>;
      readonly file?: { readonly name: string; readonly handle: PolicyFileHandle | undefined };
    }
  /** A load or save ended without changing what is being edited; no notice keeps the current one. */
  | { readonly type: "settled"; readonly notice?: Notice };

export const textOf = (editing: Editing) => serializePolicy(editing.document, editing.opened);

export function isDirty(editing: Editing, text = textOf(editing)): boolean {
  return editing.saved === undefined
    ? !jsonEqual(editing.document, NEW_POLICY)
    : text !== editing.saved;
}

/** Messages come from servers and parsers, with or without a final period. */
const sentence = (message: string) => `${message.replace(/[.\s]+$/, "")}.`;

/** `etag` null means the save created `name`, as New, Fork and a first save do. */
export function afterRemoteSave(
  submitted: OpenedText,
  name: string,
  etag: string | null,
  result: RemoteSave,
  policies?: ReadonlyArray<PolicySummary>,
): SessionAction {
  switch (result.status) {
    case "saved":
      return {
        type: "saved",
        submitted,
        target: { name, etag: result.etag, savedAt: result.savedAt },
        ...(policies === undefined ? {} : { policies }),
        notice: {
          tone: "info",
          text: `Saved ${name} (${sha12(result.etag)}). Hosts following it pick it up within about 2 minutes, restarting their T3 server to apply it.`,
        },
      };
    case "conflict":
      return {
        type: "settled",
        notice: {
          tone: "error",
          text:
            etag === null
              ? `A policy named ${name} already exists, so nothing was saved. Pick another name, or open ${name} from the list.`
              : `${name} changed elsewhere since you loaded it, so this save was refused and your edits are still here. Download them if you need them, then Reload to get the current version.`,
        },
      };
    case "error":
      return {
        type: "settled",
        notice: { tone: "error", text: `Could not save ${name}: ${sentence(result.message)}` },
      };
  }
}

function opened(state: Session, action: Extract<SessionAction, { type: "opened" }>): Session {
  const { list, name, load } = action;
  switch (list.status) {
    case "absent":
      return { ...state, fleet: { mode: "files" } };
    case "failed":
      // A failed reload leaves the policy being edited, and its ETag, as they were.
      return state.fleet.mode === "ready"
        ? {
            ...state,
            notice: {
              tone: "error",
              text: `Could not reload the policies: ${sentence(list.message)}`,
            },
          }
        : {
            ...state,
            fleet: { mode: "failed" },
            notice: {
              tone: "error",
              text: `Could not load the policies: ${sentence(list.message)} Retry before saving.`,
            },
          };
    case "listed":
      break;
  }
  const { policies } = list;
  const empty = (notice: Notice | undefined): Session => ({
    ...state,
    editing: FRESH,
    fleet: { mode: "ready", policies, target: undefined },
    notice: action.notice ?? notice,
  });
  if (name === undefined || load === undefined) {
    return empty({
      tone: "info",
      text: "No policy is stored yet. Save names and publishes this one.",
    });
  }
  switch (load.status) {
    case "missing":
      return empty({ tone: "error", text: `There is no policy named ${name}.` });
    case "failed":
      return state.fleet.mode === "ready"
        ? {
            ...state,
            fleet: { ...state.fleet, policies },
            notice: { tone: "error", text: `Could not load ${name}: ${sentence(load.message)}` },
          }
        : {
            ...state,
            fleet: { mode: "failed" },
            notice: {
              tone: "error",
              text: `Could not load ${name}: ${sentence(load.message)} Retry before saving.`,
            },
          };
    case "saved":
      break;
  }
  const target = { name, etag: load.etag, savedAt: load.savedAt };
  const read = readPolicyText(load.text);
  if (!read.ok) {
    return {
      ...state,
      editing: { ...FRESH, name: `${name}.json` },
      fleet: { mode: "ready", policies, target: { ...target, unreadable: true } },
      notice: {
        tone: "error",
        text: `The saved ${name} (${sha12(load.etag)}) cannot be opened: ${sentence(read.message)} This is a new policy; Save asks before replacing the saved one.`,
      },
    };
  }
  return {
    ...state,
    editing: {
      document: read.document,
      opened: { text: load.text, document: read.document },
      saved: load.text,
      name: `${name}.json`,
      handle: undefined,
    },
    fleet: { mode: "ready", policies, target: { ...target, unreadable: false } },
    notice: action.notice,
  };
}

export function sessionReducer(state: Session, action: SessionAction): Session {
  switch (action.type) {
    case "edit":
      // A load replaces the whole document, so the editor is read-only until it settles.
      if (state.fleet.mode === "loading" || state.replacing) return state;
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
      return { ...state, busy: true, replacing: action.replacing };
    case "import":
      return {
        ...state,
        editing: {
          document: action.document,
          opened: { text: action.file.text, document: action.document },
          // Opening a file to save back to it is not a change; importing into a policy is.
          saved: state.fleet.mode === "files" ? action.file.text : state.editing.saved,
          name: state.fleet.mode === "files" ? action.file.name : state.editing.name,
          handle: state.fleet.mode === "files" ? action.file.handle : undefined,
        },
        notice: action.notice,
      };
    case "opened":
      return { ...opened(state, action), busy: false, replacing: false };
    case "draft":
      if (state.fleet.mode !== "ready") return state;
      return {
        ...state,
        editing: { ...FRESH, name: `${action.name}.json` },
        fleet: {
          ...state.fleet,
          target: { name: action.name, etag: null, savedAt: undefined, unreadable: false },
        },
        notice: { tone: "info", text: `Save creates ${action.name}.` },
      };
    case "saved": {
      const { target, policies } = action;
      return {
        ...state,
        busy: false,
        replacing: false,
        editing: {
          ...state.editing,
          ...action.file,
          ...(target === undefined ? {} : { name: `${target.name}.json` }),
          opened: action.submitted,
          saved: action.submitted.text,
        },
        fleet:
          target === undefined || state.fleet.mode !== "ready"
            ? state.fleet
            : {
                mode: "ready",
                target: { ...target, unreadable: false },
                policies:
                  policies ??
                  state.fleet.policies.map((policy) =>
                    policy.name === target.name
                      ? { ...policy, etag: target.etag, modifiedAt: target.savedAt }
                      : policy,
                  ),
              },
        notice: action.notice,
      };
    }
    case "settled":
      return { ...state, busy: false, replacing: false, notice: action.notice ?? state.notice };
  }
}

/** The names the picker offers: the stored ones, plus a draft not saved yet. */
export function pickerNames(fleet: Fleet): ReadonlyArray<string> {
  if (fleet.mode !== "ready") return [];
  const names = fleet.policies.map((policy) => policy.name);
  const target = fleet.target?.name;
  return target === undefined || names.includes(target) ? names : [...names, target].toSorted();
}
