import type { DevUpdatesState } from "@t3tools/shared/devUpdates";
import { describe, expect, it } from "vite-plus/test";

import { describeDevUpdates } from "./devUpdatesSettings.logic";

const bundle = (commit: string | null, updateId = "0b5e2f9c-update") => ({
  updateId,
  commit,
  createdAt: "2026-11-15T00:00:00.000Z",
});
const state = (overrides: Partial<DevUpdatesState>): DevUpdatesState => ({
  enabled: false,
  runtimeVersion: "1.2.80",
  running: null,
  pending: null,
  ...overrides,
});

describe("describeDevUpdates", () => {
  it.each<[string, DevUpdatesState, boolean | null, string, boolean]>([
    [
      "off",
      state({}),
      null,
      "This browser gets release 1.2.80. Turn on to get each build from dev.",
      false,
    ],
    [
      "serving a dev build",
      state({ enabled: true, running: bundle("abc1234def") }),
      null,
      "This browser gets dev abc1234, built for release 1.2.80.",
      false,
    ],
    [
      "on without a dev build",
      state({ enabled: true }),
      null,
      "No dev build for release 1.2.80 yet, so this browser gets the release.",
      false,
    ],
    [
      "just turned on",
      state({ enabled: true, running: bundle(null) }),
      false,
      "This browser gets dev 0b5e2f9c, built for release 1.2.80. Reload to apply.",
      true,
    ],
    [
      "turned on and back off",
      state({}),
      false,
      "This browser gets release 1.2.80. Turn on to get each build from dev.",
      false,
    ],
  ])("hub: %s", (_label, current, enabledBeforeChange, description, offerReload) => {
    expect(describeDevUpdates({ kind: "hub", state: current, enabledBeforeChange })).toEqual({
      description,
      offerReload,
    });
  });

  it.each<[string, DevUpdatesState, string]>([
    ["off", state({}), "Running release 1.2.80. Turn on to get each build from dev."],
    [
      "turned off while a dev build runs",
      state({ running: bundle("abc1234def") }),
      "Running dev abc1234 on release 1.2.80. The next launch runs release 1.2.80.",
    ],
    [
      "on, waiting for a download",
      state({ enabled: true }),
      "Running release 1.2.80. Dev builds download in the background and apply at the next launch.",
    ],
    [
      "on with a newer build downloaded",
      state({ enabled: true, running: bundle("abc1234def"), pending: bundle("fed9876abc") }),
      "Running dev abc1234 on release 1.2.80. The next launch runs dev fed9876.",
    ],
    [
      "on and current",
      state({ enabled: true, running: bundle("abc1234def") }),
      "Running dev abc1234 on release 1.2.80.",
    ],
  ])("desktop: %s", (_label, current, description) => {
    expect(
      describeDevUpdates({ kind: "desktop", state: current, enabledBeforeChange: false }),
    ).toEqual({ description, offerReload: false });
  });
});
