import { DEV_UPDATES_MANIFEST_URL } from "@t3tools/shared/devUpdates";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveDevUpdatesState,
  type DevUpdatesSnapshot,
  isForkUpdatesBuild,
  needsReload,
  shortCommit,
} from "./dev-updates.logic";

const EMBEDDED = { isEmbeddedLaunch: true, isEmergencyLaunch: false, updateId: "embedded-id" };
const DEV_RUNNING = {
  isEmbeddedLaunch: false,
  isEmergencyLaunch: false,
  updateId: "dev-1",
  createdAt: new Date("2026-11-10T00:00:00Z"),
  manifest: { metadata: { gitCommit: "0123456789abcdef" } },
};
const DEV_DOWNLOADED = {
  updateId: "dev-2",
  createdAt: new Date("2026-11-12T00:00:00Z"),
  manifest: { metadata: { gitCommit: "fedcba9876543210" } },
};

function snapshot(overrides: Partial<DevUpdatesSnapshot>): DevUpdatesSnapshot {
  return {
    enabled: false,
    runtimeVersion: "1.2.40",
    running: EMBEDDED,
    downloaded: null,
    ...overrides,
  };
}

describe("deriveDevUpdatesState", () => {
  it.each([
    {
      name: "built-in bundle with a dev download",
      input: snapshot({ enabled: true, downloaded: DEV_DOWNLOADED }),
      running: null,
      pending: { updateId: "dev-2", commit: "fedcba9876543210" },
      reload: true,
    },
    {
      name: "emergency launch of the built-in bundle",
      input: snapshot({
        enabled: true,
        running: { isEmbeddedLaunch: false, isEmergencyLaunch: true },
      }),
      running: null,
      pending: null,
      reload: false,
    },
    {
      name: "dev bundle running after switching off",
      input: snapshot({ enabled: false, running: DEV_RUNNING, downloaded: DEV_DOWNLOADED }),
      running: { updateId: "dev-1", commit: "0123456789abcdef" },
      pending: null,
      reload: true,
    },
    {
      name: "dev bundle running with nothing newer",
      input: snapshot({
        enabled: true,
        running: DEV_RUNNING,
        downloaded: { ...DEV_RUNNING },
      }),
      running: { updateId: "dev-1", commit: "0123456789abcdef" },
      pending: null,
      reload: false,
    },
    {
      name: "rollback download has no update id",
      input: snapshot({ enabled: true, downloaded: { createdAt: new Date(0) } }),
      running: null,
      pending: null,
      reload: false,
    },
  ])("$name", ({ input, running, pending, reload }) => {
    const state = deriveDevUpdatesState(input);
    expect(state.running).toEqual(running && expect.objectContaining(running));
    expect(state.pending).toEqual(pending && expect.objectContaining(pending));
    expect(needsReload(state)).toBe(reload);
  });

  it("falls back to the update id when the manifest has no commit", () => {
    const state = deriveDevUpdatesState(
      snapshot({ running: { ...DEV_RUNNING, updateId: "a1b2c3d4-e5f6", manifest: {} } }),
    );
    expect(state.running?.commit).toBeNull();
    expect(state.running && shortCommit(state.running)).toBe("a1b2c3d4");
  });
});

describe("isForkUpdatesBuild", () => {
  it.each([
    { url: DEV_UPDATES_MANIFEST_URL, channel: "production", expected: true },
    { url: undefined, channel: "dev", expected: true },
    { url: "https://u.expo.dev/project", channel: "production", expected: false },
    { url: undefined, channel: null, expected: false },
  ])("$url on $channel is $expected", ({ url, channel, expected }) => {
    expect(isForkUpdatesBuild(url, channel)).toBe(expected);
  });
});
