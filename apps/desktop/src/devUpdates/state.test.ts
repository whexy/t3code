import { describe, expect, it } from "vite-plus/test";

import type { DevUpdateManifest } from "./protocol.ts";
import * as DevState from "./state.ts";

const APP_VERSION = "0.1.10-nightly.20261113.4656.20261114020203";

const bundle = (updateId: string, runtimeVersion = APP_VERSION): DevState.StoredBundle => ({
  updateId,
  commit: null,
  createdAt: "2026-11-15T08:00:00.000Z",
  runtimeVersion,
});

const manifest = (id: string, runtimeVersion = APP_VERSION): DevUpdateManifest => ({
  id,
  createdAt: "2026-11-15T09:00:00.000Z",
  runtimeVersion,
  launchAsset: {
    hash: "abc",
    key: "bundle",
    contentType: "application/gzip",
    fileExtension: "tgz",
    url: "https://ota.clusters.work/t3code/assets/abc.tgz",
  },
  metadata: { gitCommit: "4b825dc" },
});

describe("selectLaunchBundle", () => {
  it.each([
    ["a ready bundle for this version", { enabled: true, ready: bundle("a"), bad: [] }, "a"],
    ["nothing while disabled", { enabled: false, ready: bundle("a"), bad: [] }, null],
    [
      "nothing built for another version",
      { enabled: true, ready: bundle("a", "0.1.9"), bad: [] },
      null,
    ],
    ["nothing that failed before", { enabled: true, ready: bundle("a"), bad: ["a"] }, null],
    ["nothing when none is ready", { enabled: true, ready: null, bad: [] }, null],
  ])("serves %s", (_label, state, expected) => {
    expect(DevState.selectLaunchBundle(state, APP_VERSION)?.updateId ?? null).toBe(expected);
  });
});

describe("applyManifestResponse", () => {
  const state: DevState.StoredState = { enabled: true, ready: bundle("a"), bad: ["bad"] };
  const apply = (response: Parameters<typeof DevState.applyManifestResponse>[0]["response"]) =>
    DevState.applyManifestResponse({
      state,
      response,
      running: bundle("a"),
      appVersion: APP_VERSION,
    });

  it("drops the ready bundle on rollBackToEmbedded", () => {
    expect(apply({ _tag: "RollBackToEmbedded" })).toEqual({
      _tag: "Keep",
      state: { ...state, ready: null },
    });
  });

  it("keeps the running bundle when no update is available", () => {
    expect(
      DevState.applyManifestResponse({
        state: { ...state, ready: bundle("b") },
        response: { _tag: "NoUpdate" },
        running: bundle("a"),
        appVersion: APP_VERSION,
      }),
    ).toEqual({ _tag: "Keep", state });
  });

  it("downloads a new update with its commit", () => {
    expect(apply({ _tag: "Update", manifest: manifest("c") })).toEqual({
      _tag: "Download",
      bundle: {
        updateId: "c",
        commit: "4b825dc",
        createdAt: "2026-11-15T09:00:00.000Z",
        runtimeVersion: APP_VERSION,
      },
    });
  });

  it.each([
    ["one that failed here", manifest("bad")],
    ["one built for another version", manifest("c", "0.1.9")],
    ["the one already ready", manifest("a")],
  ])("does not download %s", (_label, update) => {
    expect(apply({ _tag: "Update", manifest: update })).toEqual({ _tag: "Keep", state });
  });
});

it("never serves a bundle again once it is marked bad", () => {
  const state = DevState.markBad({ enabled: true, ready: bundle("a"), bad: [] }, "a");
  expect(DevState.selectLaunchBundle(state, APP_VERSION)).toBeNull();
  expect(
    DevState.applyManifestResponse({
      state,
      response: { _tag: "Update", manifest: manifest("a") },
      running: null,
      appVersion: APP_VERSION,
    }),
  ).toEqual({ _tag: "Keep", state });
});

it("turning the lane off sends the next launch to the embedded bundle", () => {
  const state = DevState.setEnabled({ enabled: true, ready: bundle("a"), bad: [] }, false);
  expect(DevState.selectLaunchBundle(DevState.setEnabled(state, true), APP_VERSION)).toBeNull();
  expect(DevState.toBridgeState({ state, running: bundle("a"), appVersion: APP_VERSION })).toEqual({
    enabled: false,
    runtimeVersion: APP_VERSION,
    running: { updateId: "a", commit: null, createdAt: "2026-11-15T08:00:00.000Z" },
    pending: null,
  });
});
