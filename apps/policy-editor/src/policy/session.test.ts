// @effect-diagnostics globalDate:off - Fixed timestamps for the reducer, outside any Effect program.
import { describe, expect, it } from "vite-plus/test";

import type { RemoteLoad } from "./remote.ts";
import {
  afterRemoteSave,
  FRESH,
  INITIAL_SESSION,
  isDirty,
  type Session,
  type SessionAction,
  sessionReducer,
  textOf,
} from "./session.ts";

const SAVED_TEXT = '{"schemaVersion":1,"organization":"dotfiles"}\n';
const savedAt = new Date(Date.UTC(2026, 10, 2));
const saved = (text = SAVED_TEXT, etag = '"v1"'): RemoteLoad => ({
  status: "saved",
  text,
  etag,
  savedAt,
});
const run = (state: Session, ...actions: ReadonlyArray<SessionAction>) =>
  actions.reduce(sessionReducer, state);
const loaded = (load: RemoteLoad) => run(INITIAL_SESSION, { type: "loaded", load });

describe("saving the fleet policy", () => {
  it("keeps edits made while a save is in flight unsaved", () => {
    const start = run(loaded(saved()), { type: "edit", segments: ["organization"], value: "a" });
    const submitted = { text: textOf(start.editing), document: start.editing.document };

    const done = run(
      start,
      { type: "begin" },
      { type: "edit", segments: ["organization"], value: "b" },
      afterRemoteSave(submitted, { status: "saved", etag: '"v2"', savedAt }),
    );

    expect(done.editing.opened).toBe(submitted);
    expect(done.editing.document).toEqual({ schemaVersion: 1, organization: "b" });
    expect(isDirty(done.editing)).toBe(true);
    expect(done.fleet).toEqual({ mode: "ready", etag: '"v2"', savedAt, unreadable: false });
    expect(done.busy).toBe(false);

    const quiet = run(
      start,
      { type: "begin" },
      afterRemoteSave(submitted, { status: "saved", etag: '"v2"', savedAt }),
    );
    expect(isDirty(quiet.editing)).toBe(false);
  });

  it("keeps the loaded version after a refused save, so Reload is the way on", () => {
    const start = run(loaded(saved()), { type: "edit", segments: ["organization"], value: "a" });
    const submitted = { text: textOf(start.editing), document: start.editing.document };

    const refused = run(
      start,
      { type: "begin" },
      afterRemoteSave(submitted, { status: "conflict" }),
    );

    expect(refused.fleet).toEqual(start.fleet);
    expect(isDirty(refused.editing)).toBe(true);
    expect(refused.notice).toMatchObject({ tone: "error", text: expect.stringMatching(/Reload/) });
  });
});

describe("loading the fleet policy", () => {
  it("stays on the fleet when the first load fails, and a retry loads it", () => {
    const failed = loaded({ status: "failed", message: "HTTP 502" });
    expect(failed.fleet).toEqual({ mode: "failed" });
    expect(failed.busy).toBe(false);
    expect(failed.notice).toMatchObject({ tone: "error", text: expect.stringMatching(/HTTP 502/) });

    const retried = run(failed, { type: "begin" }, { type: "loaded", load: saved() });
    expect(retried.fleet).toMatchObject({ mode: "ready", etag: '"v1"' });
    expect(retried.editing.opened?.text).toBe(SAVED_TEXT);
  });

  it("ignores edits until the first load settles", () => {
    const early = run(INITIAL_SESSION, {
      type: "edit",
      segments: ["organization"],
      value: "typed early",
    });
    expect(early.editing).toBe(FRESH);

    const ready = run(
      early,
      { type: "loaded", load: saved() },
      {
        type: "edit",
        segments: ["organization"],
        value: "typed later",
      },
    );
    expect(ready.editing.document).toEqual({ schemaVersion: 1, organization: "typed later" });
  });

  it("keeps the version being edited when a reload fails", () => {
    const edited = run(loaded(saved()), { type: "edit", segments: ["organization"], value: "a" });

    const failed = run(
      edited,
      { type: "begin" },
      { type: "loaded", load: { status: "failed", message: "timeout" } },
    );

    expect(failed.fleet).toEqual(edited.fleet);
    expect(failed.editing).toBe(edited.editing);
  });

  it("works on files only when there is no policy server", () => {
    expect(loaded({ status: "absent" }).fleet).toEqual({ mode: "files" });
  });

  it("does not open a saved policy it cannot read, and marks it so Save asks first", () => {
    for (const text of ["{oops", "[]"]) {
      const state = loaded(saved(text, '"bad"'));
      expect(state.editing).toBe(FRESH);
      expect(state.fleet).toEqual({ mode: "ready", etag: '"bad"', savedAt, unreadable: true });
      expect(state.notice?.tone).toBe("error");

      const submitted = { text: textOf(state.editing), document: state.editing.document };
      const replaced = run(
        state,
        { type: "begin" },
        afterRemoteSave(submitted, { status: "saved", etag: '"v2"', savedAt }),
      );
      expect(replaced.fleet).toMatchObject({ etag: '"v2"', unreadable: false });
    }
  });
});
