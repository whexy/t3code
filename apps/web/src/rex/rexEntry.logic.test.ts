import { describe, expect, it } from "vite-plus/test";

import {
  NO_OPERATE_SCOPE,
  OPEN_FROM_DESKTOP,
  reportFor,
  rexEntry,
  rexLeads,
} from "./rexEntry.logic";

const available = { available: true, hostId: "host" } as const;
const down = { available: false, reason: "rex server is not running" } as const;

describe("rexEntry", () => {
  it.each([
    ["a Mac without Rex hides it", false, available, { kind: "hidden" }],
    ["a desktop still probing hides it", undefined, available, { kind: "hidden" }],
    ["a host without Rex says why", true, down, { kind: "disabled", reason: down.reason }],
    ["a browser says why", null, available, { kind: "disabled", reason: OPEN_FROM_DESKTOP }],
    [
      "a host's reason outranks the browser's",
      null,
      down,
      { kind: "disabled", reason: down.reason },
    ],
    ["an unanswered host hides it", true, undefined, { kind: "hidden" }],
    ["desktop with Rex on both ends opens", true, available, { kind: "enabled" }],
  ] as const)("%s", (_, macRex, host, expected) => {
    expect(rexEntry({ macRex, host, canOperate: true })).toEqual(expected);
  });

  it("a connection that can't operate the host says why", () => {
    expect(rexEntry({ macRex: true, host: available, canOperate: false })).toEqual({
      kind: "disabled",
      reason: NO_OPERATE_SCOPE,
    });
  });
});

describe("rexLeads", () => {
  it.each([
    ["chosen and openable", true, { kind: "enabled" }, true],
    ["not chosen", false, { kind: "enabled" }, false],
    ["chosen, but a browser", true, { kind: "disabled", reason: OPEN_FROM_DESKTOP }, false],
    ["chosen, but no Rex on the host", true, { kind: "disabled", reason: "no rex" }, false],
    ["chosen, but a file is targeted", true, { kind: "hidden" }, false],
  ] as const)("%s: %s", (_, preferred, entry, leads) => {
    expect(rexLeads({ preferred, entry })).toBe(leads);
  });
});

describe("reportFor", () => {
  it.each([
    ["selected", "confirm"],
    ["failed", "abandon"],
    ["expired", "abandon"],
    ["timedOut", null],
  ] as const)("%s reports %s", (outcome, report) => {
    expect(reportFor(outcome)).toBe(report);
  });
});
