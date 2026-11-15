import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { readPairingAppLink } from "@t3tools/shared/remote";

import {
  buildPairingBundleCodes,
  buildPairingBundleLink,
  MAX_QR_LINK_LENGTH,
  readPairingBundle,
  readPairingBundlePart,
  summarizeFleetRedeem,
  unwrapSingleHostLink,
  withDistinctLabels,
} from "./fleetPairing.ts";

const DEIMOS = "https://deimos-t3.example.test/pair#token=aaa";
const PHOBOS = "https://phobos-t3.example.test/pair#token=bbb";

describe("pairing bundle link", () => {
  it("round-trips every host, and a single-link reader still gets the first", () => {
    const link = buildPairingBundleLink([DEIMOS, PHOBOS]);
    expect(readPairingBundle(link)).toEqual([DEIMOS, PHOBOS]);
    expect(readPairingAppLink(link)).toBe(DEIMOS);
  });

  it("splits a large fleet across codes that each fit and together hold every host", () => {
    const urls = Array.from(
      { length: 12 },
      (_, index) => `https://host-${index}-t3.clusters.example.test/pair#token=ABCDEFGHJKLM`,
    );
    const codes = buildPairingBundleCodes(urls, "b1");
    expect(codes.length).toBeGreaterThan(1);
    for (const code of codes) expect(code.length).toBeLessThanOrEqual(MAX_QR_LINK_LENGTH);
    expect(codes.flatMap((code) => readPairingBundle(code) ?? [])).toEqual(urls);
    expect(codes.map(readPairingBundlePart)).toEqual(
      codes.map((_, index) => ({ bundle: "b1", part: index + 1, parts: codes.length })),
    );
  });

  it("unwraps a one-host app link for the ordinary pairing path, and leaves others alone", () => {
    const single = buildPairingBundleLink([DEIMOS]);
    const several = buildPairingBundleLink([DEIMOS, PHOBOS]);
    const [part] = buildPairingBundleCodes([DEIMOS, PHOBOS], "b1", 100);
    expect(unwrapSingleHostLink(single)).toBe(DEIMOS);
    expect(unwrapSingleHostLink(DEIMOS)).toBe(DEIMOS);
    expect(unwrapSingleHostLink(several)).toBe(several);
    expect(unwrapSingleHostLink(part!)).toBe(part);
  });

  it("keeps a small fleet in one code with no part", () => {
    const [code, ...rest] = buildPairingBundleCodes([DEIMOS, PHOBOS], "b1");
    expect(rest).toEqual([]);
    expect(code).toBe(buildPairingBundleLink([DEIMOS, PHOBOS]));
    expect(readPairingBundlePart(code!)).toBeNull();
  });

  it.each([
    ["a single-host app link", `t3code://pair?pairingUrl=${encodeURIComponent(DEIMOS)}`, [DEIMOS]],
    ["a dev channel link", `t3code-dev://pair?pairingUrl=${encodeURIComponent(DEIMOS)}`, [DEIMOS]],
    ["a plain pairing URL", DEIMOS, null],
    ["another app link", "t3code://threads/1", null],
    ["a pair link without hosts", "t3code://pair?pairingUrl=", null],
    ["garbage", "not a link", null],
  ])("reads %s", (_name, value, expected) => {
    expect(readPairingBundle(value)).toEqual(expected);
  });
});

const paired = (label: string) => ({
  _tag: "Paired" as const,
  label,
  environmentId: EnvironmentId.make(label),
});
const failed = (label: string, detail: string) => ({ _tag: "Failed" as const, label, detail });
const already = (label: string) => ({
  _tag: "AlreadyPaired" as const,
  label,
  environmentId: EnvironmentId.make(label),
});

describe("fleet host labels", () => {
  it("adds the address only to labels that several hosts share", () => {
    const labels = withDistinctLabels([
      { item: { label: "mudd" }, address: "mudd-t3.example.test" },
      { item: { label: "mudd" }, address: "127.0.0.1:47812" },
      { item: { label: "deimos" }, address: "deimos-t3.example.test" },
    ]).map((item) => item.label);
    expect(labels).toEqual(["mudd (mudd-t3.example.test)", "mudd (127.0.0.1:47812)", "deimos"]);
  });
});

describe("fleet redeem summary", () => {
  it.each([
    ["all paired", [paired("mudd"), paired("deimos")], "paired", "Paired 2 environments", []],
    [
      "some failed",
      [paired("mudd"), failed("wsl", "The pairing link expired")],
      "partial",
      "Paired 1 of 2 environments",
      ["wsl: The pairing link expired."],
    ],
    [
      "all failed",
      [failed("mudd", "Offline."), failed("wsl", "Offline")],
      "failed",
      "Could not pair 2 environments",
      ["mudd: Offline.", "wsl: Offline."],
    ],
    ["one host", [failed("wsl", "Offline")], "failed", "Could not pair wsl", ["wsl: Offline."]],
    [
      "a new host beside hosts already paired",
      [paired("mars"), already("deimos"), already("phobos")],
      "paired",
      "Paired 1 environment",
      ["Already paired: deimos, phobos."],
    ],
    [
      "only hosts already paired",
      [already("deimos"), already("phobos")],
      "paired",
      "Already paired with all 2 environments",
      [],
    ],
    [
      "a failure beside hosts already paired",
      [failed("wsl", "Offline"), already("deimos")],
      "partial",
      "Could not pair 1 environment",
      ["wsl: Offline.", "Already paired: deimos."],
    ],
  ] as const)("summarizes %s", (_name, results, outcome, title, details) => {
    expect(summarizeFleetRedeem(results)).toMatchObject({ outcome, title, details });
  });
});
