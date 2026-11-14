import { expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion } from "./updateChannels.ts";

// The fork's builds append their commit time (whexy/t3code nix/t3-server.nix).
it.each([
  ["0.1.10-nightly.20261113.4656", true],
  ["0.1.10-nightly.20261113.4656.20261114020203", true],
  ["0.1.10-nightly.20261113.4656.20261114020203.1", false],
  ["0.1.10", false],
] as const)("reads %s as nightly: %s", (version, nightly) => {
  expect(isNightlyDesktopVersion(version)).toBe(nightly);
});
