import { FleetPairing } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_BUNDLE_SCAN,
  type BundleScanPlan,
  type BundleScanState,
  bundleScanReport,
  planBundleScan,
  recordBundleScan,
} from "./fleetPairingScan";

const host = (name: string) => `https://${name}.example.test/pair#token=${name}-token`;
const paired = (label: string): FleetPairing.FleetRedeemResult => ({
  _tag: "Paired",
  label,
  environmentId: EnvironmentId.make(label),
});
const already = (label: string): FleetPairing.FleetRedeemResult => ({
  _tag: "AlreadyPaired",
  label,
  environmentId: EnvironmentId.make(label),
});
const failed = (label: string): FleetPairing.FleetRedeemResult => ({
  _tag: "Failed",
  label,
  detail: "Unreachable",
});

function partLink(bundle: string, urls: ReadonlyArray<string>, part: number, parts: number) {
  const link = new URL(FleetPairing.buildPairingBundleLink(urls));
  link.searchParams.set("part", String(part));
  link.searchParams.set("parts", String(parts));
  link.searchParams.set("bundle", bundle);
  return link.toString();
}

function redeemPlan(state: BundleScanState, value: string) {
  const plan = planBundleScan(state, value);
  if (plan?.kind !== "redeem") throw new Error(`expected a redeem, got ${plan?.kind}`);
  return plan;
}

function redeem(
  state: BundleScanState,
  value: string,
  results: ReadonlyArray<FleetPairing.FleetRedeemResult>,
): { readonly plan: Extract<BundleScanPlan, { kind: "redeem" }>; readonly state: BundleScanState } {
  const plan = redeemPlan(state, value);
  return { plan, state: recordBundleScan(plan, results) };
}

describe("planBundleScan", () => {
  it("leaves ordinary links and single-host app links to the single-host path", () => {
    const single = FleetPairing.buildPairingBundleLink([host("mudd")]);
    expect(planBundleScan(EMPTY_BUNDLE_SCAN, host("mudd"))).toBeNull();
    expect(planBundleScan(EMPTY_BUNDLE_SCAN, single)).toBeNull();
  });

  it("takes codes in any order and reports what is left", () => {
    const code1 = partLink("b1", [host("mudd")], 1, 3);
    const code2 = partLink("b1", [host("deimos"), host("neith")], 2, 3);
    const code3 = partLink("b1", [host("phobos")], 3, 3);

    let step = redeem(EMPTY_BUNDLE_SCAN, code3, [paired("phobos")]);
    expect(step.plan.allScanned).toBe(false);
    expect(bundleScanReport(step.state).nextPart).toBe(1);
    expect(planBundleScan(step.state, code3)).toEqual({ kind: "done", part: 3, parts: 3 });

    step = redeem(step.state, code1, [already("mudd")]);
    expect(bundleScanReport(step.state).nextPart).toBe(2);
    expect(planBundleScan(step.state, code1)?.kind).toBe("done");

    step = redeem(step.state, code2, [paired("deimos"), paired("neith")]);
    expect(step.plan.allScanned).toBe(true);
    const report = bundleScanReport(step.state);
    expect(report.nextPart).toBeNull();
    expect(report.failedParts).toEqual([]);
    expect(report.results.map((result) => result.label)).toEqual([
      "phobos",
      "mudd",
      "deimos",
      "neith",
    ]);
  });

  it("retries only the hosts of a code that failed", () => {
    const code1 = partLink("b1", [host("mudd"), host("deimos"), host("neith")], 1, 2);
    const code2 = partLink("b1", [host("phobos")], 2, 2);

    let step = redeem(EMPTY_BUNDLE_SCAN, code1, [
      paired("mudd"),
      failed("deimos"),
      already("neith"),
    ]);
    step = redeem(step.state, code2, [paired("phobos")]);
    expect(bundleScanReport(step.state).failedParts).toEqual([1]);

    const retry = redeemPlan(step.state, code1);
    expect(retry.pairingUrls).toEqual([host("deimos")]);
    expect(retry.allScanned).toBe(true);
    const retried = recordBundleScan(retry, [paired("deimos")]);
    expect(bundleScanReport(retried).failedParts).toEqual([]);
    expect(bundleScanReport(retried).results.map((result) => result._tag)).toEqual([
      "Paired",
      "Paired",
      "AlreadyPaired",
      "Paired",
    ]);
  });

  it("starts over for codes from another mint", () => {
    const { state } = redeem(EMPTY_BUNDLE_SCAN, partLink("b1", [host("mudd")], 1, 2), [
      paired("mudd"),
    ]);
    const fresh = redeemPlan(state, partLink("b2", [host("mudd")], 1, 2));
    expect(fresh.base.scanned.size).toBe(0);
    expect(fresh.pairingUrls).toEqual([host("mudd")]);
  });
});
