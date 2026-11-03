// @effect-diagnostics globalDate:off - Fixed timestamps for the reducer, outside any Effect program.
import { describe, expect, it } from "vite-plus/test";

import type { PolicySummary, RemoteList, RemoteLoad } from "./remote.ts";
import {
  afterRemoteSave,
  FRESH,
  INITIAL_SESSION,
  isDirty,
  pickerNames,
  type Session,
  type SessionAction,
  sessionReducer,
  textOf,
} from "./session.ts";

const SAVED_TEXT = '{"schemaVersion":1,"organization":"dotfiles"}\n';
const savedAt = new Date(Date.UTC(2026, 10, 2));
const summary = (name: string, etag = '"v1"'): PolicySummary => ({
  name,
  etag,
  modifiedAt: savedAt,
  publicUrl: `https://t3-policy.clusters.work/${name}.json`,
});
const LIST: RemoteList = { status: "listed", policies: [summary("dotfiles"), summary("work")] };
const saved = (text = SAVED_TEXT, etag = '"v1"'): RemoteLoad => ({
  status: "saved",
  text,
  etag,
  savedAt,
});
const run = (state: Session, ...actions: ReadonlyArray<SessionAction>) =>
  actions.reduce(sessionReducer, state);
const open = (load: RemoteLoad, name = "dotfiles", list: RemoteList = LIST): SessionAction => ({
  type: "opened",
  list,
  name,
  load,
});
const loaded = (load: RemoteLoad, name = "dotfiles") => run(INITIAL_SESSION, open(load, name));
const edited = () => run(loaded(saved()), { type: "edit", segments: ["organization"], value: "a" });
const submittedOf = (state: Session) => ({
  text: textOf(state.editing),
  document: state.editing.document,
});

describe("saving a policy", () => {
  it("keeps edits made while a save is in flight unsaved", () => {
    const start = edited();
    const submitted = submittedOf(start);
    const result = { status: "saved", etag: '"v2"', savedAt } as const;

    const done = run(
      start,
      { type: "begin" },
      { type: "edit", segments: ["organization"], value: "b" },
      afterRemoteSave(submitted, "dotfiles", '"v1"', result),
    );

    expect(done.editing.opened).toBe(submitted);
    expect(done.editing.document).toEqual({ schemaVersion: 1, organization: "b" });
    expect(isDirty(done.editing)).toBe(true);
    expect(done.fleet).toMatchObject({
      target: { name: "dotfiles", etag: '"v2"', savedAt, unreadable: false },
      policies: [summary("dotfiles", '"v2"'), summary("work")],
    });
    expect(done.busy).toBe(false);

    const quiet = run(
      start,
      { type: "begin" },
      afterRemoteSave(submitted, "dotfiles", '"v1"', result),
    );
    expect(isDirty(quiet.editing)).toBe(false);
  });

  it("keeps the edits and the loaded version after a refused save, so Reload is the way on", () => {
    const start = edited();

    const refused = run(
      start,
      { type: "begin" },
      afterRemoteSave(submittedOf(start), "dotfiles", '"v1"', {
        status: "conflict",
        message: "changed",
      }),
    );

    expect(refused.fleet).toEqual(start.fleet);
    expect(refused.editing).toBe(start.editing);
    expect(isDirty(refused.editing)).toBe(true);
    expect(refused.notice).toMatchObject({ tone: "error", text: expect.stringMatching(/Reload/) });
  });

  it("forks to a new name, leaving the original as saved, and refuses a name in use", () => {
    const start = edited();
    const submitted = submittedOf(start);
    const policies = [...LIST.policies, summary("copy", '"c1"')];

    const forked = run(
      start,
      { type: "begin" },
      afterRemoteSave(
        submitted,
        "copy",
        null,
        { status: "saved", etag: '"c1"', savedAt },
        policies,
      ),
    );
    expect(forked.fleet).toEqual({
      mode: "ready",
      policies,
      target: { name: "copy", etag: '"c1"', savedAt, unreadable: false },
    });
    expect(forked.editing).toMatchObject({ name: "copy.json", opened: submitted });
    expect(isDirty(forked.editing)).toBe(false);

    const taken = run(
      start,
      { type: "begin" },
      afterRemoteSave(submitted, "work", null, { status: "conflict", message: "exists" }),
    );
    expect(taken.fleet).toEqual(start.fleet);
    expect(taken.notice?.text).toMatch(/work already exists/);
  });

  it("creates a draft only on Save, and lists it until then", () => {
    const draft = run(loaded(saved()), { type: "draft", name: "fresh" });
    expect(draft.editing).toEqual({ ...FRESH, name: "fresh.json" });
    expect(draft.fleet).toMatchObject({ target: { name: "fresh", etag: null } });
    expect(pickerNames(draft.fleet)).toEqual(["dotfiles", "fresh", "work"]);
    expect(pickerNames(loaded(saved()).fleet)).toEqual(["dotfiles", "work"]);
  });
});

describe("opening a policy", () => {
  it("stays on the server when the first load fails, and a retry loads it", () => {
    const failed = run(INITIAL_SESSION, {
      type: "opened",
      list: { status: "failed", message: "HTTP 502" },
      name: undefined,
      load: undefined,
    });
    expect(failed.fleet).toEqual({ mode: "failed" });
    expect(failed.busy).toBe(false);
    expect(failed.notice).toMatchObject({ tone: "error", text: expect.stringMatching(/HTTP 502/) });

    const retried = run(failed, { type: "begin" }, open(saved()));
    expect(retried.fleet).toMatchObject({ mode: "ready", target: { etag: '"v1"' } });
    expect(retried.editing.opened?.text).toBe(SAVED_TEXT);
  });

  it("ignores edits until the first load settles", () => {
    const early = run(INITIAL_SESSION, {
      type: "edit",
      segments: ["organization"],
      value: "typed early",
    });
    expect(early.editing).toBe(FRESH);

    const ready = run(early, open(saved()), {
      type: "edit",
      segments: ["organization"],
      value: "typed later",
    });
    expect(ready.editing.document).toEqual({ schemaVersion: 1, organization: "typed later" });
  });

  it("keeps the policy being edited when switching or reloading fails", () => {
    const start = edited();

    for (const action of [
      open({ status: "failed", message: "timeout" }, "work"),
      {
        type: "opened",
        list: { status: "failed", message: "timeout" },
        name: undefined,
        load: undefined,
      } as const,
    ]) {
      const failed = run(start, { type: "begin" }, action);
      expect(failed.fleet).toEqual(start.fleet);
      expect(failed.editing).toBe(start.editing);
      expect(failed.notice).toMatchObject({
        tone: "error",
        text: expect.stringMatching(/timeout/),
      });
    }
  });

  it("opens the policy it switched to, and none when nothing is stored", () => {
    const switched = run(
      edited(),
      open(saved('{"schemaVersion":1,"organization":"w"}', '"w1"'), "work"),
    );
    expect(switched.fleet).toMatchObject({ target: { name: "work", etag: '"w1"' } });
    expect(switched.editing.name).toBe("work.json");
    expect(isDirty(switched.editing)).toBe(false);

    const none = run(edited(), {
      type: "opened",
      list: { status: "listed", policies: [] },
      name: undefined,
      load: undefined,
    });
    expect(none.fleet).toEqual({ mode: "ready", policies: [], target: undefined });
    expect(none.editing).toBe(FRESH);
  });

  it("works on files only when there is no policy server", () => {
    expect(
      run(INITIAL_SESSION, {
        type: "opened",
        list: { status: "absent" },
        name: undefined,
        load: undefined,
      }).fleet,
    ).toEqual({ mode: "files" });
  });

  it("does not open a saved policy it cannot read, and marks it so Save asks first", () => {
    for (const text of ["{oops", "[]"]) {
      const state = loaded(saved(text, '"bad"'));
      expect(state.editing).toEqual({ ...FRESH, name: "dotfiles.json" });
      expect(state.fleet).toMatchObject({
        target: { name: "dotfiles", etag: '"bad"', savedAt, unreadable: true },
      });
      expect(state.notice?.tone).toBe("error");

      const replaced = run(
        state,
        { type: "begin" },
        afterRemoteSave(submittedOf(state), "dotfiles", '"bad"', {
          status: "saved",
          etag: '"v2"',
          savedAt,
        }),
      );
      expect(replaced.fleet).toMatchObject({ target: { etag: '"v2"', unreadable: false } });
    }
  });
});
