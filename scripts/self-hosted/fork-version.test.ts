import { cliReleaseChannelOf, desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { expect, it } from "vite-plus/test";

import { resolveDesktopUpdateChannel } from "../build-desktop-artifact.ts";

// A fork build appends its commit time to upstream's nightly (nix/t3-server.nix).
// apps/desktop/src/updates/updateChannels.test.ts checks the desktop app's copy.
it.each([
  ["0.1.10-nightly.20261113.4656", "nightly"],
  ["0.1.10-nightly.20261113.4656.20261114020203", "nightly"],
  ["0.1.10-nightly.20261113.4656.20261114020203.1", "latest"],
  ["0.1.10", "latest"],
] as const)("puts %s on the %s track", (version, channel) => {
  expect(resolveDesktopUpdateChannel(version)).toBe(channel);
  expect(desktopUpdateChannelOf(version)).toBe(channel);
  expect(cliReleaseChannelOf(version)).toBe(channel === "nightly" ? "nightly" : "stable");
});
