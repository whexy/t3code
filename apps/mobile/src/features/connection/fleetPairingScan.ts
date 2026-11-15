import { FleetPairing } from "@t3tools/client-runtime/connection";

interface UrlResult {
  readonly part: number;
  readonly result: FleetPairing.FleetRedeemResult;
}

/** Progress through one minted set of codes, kept per pairing URL so failed hosts can be retried. */
export interface BundleScanState {
  readonly bundle: string | null;
  readonly parts: number;
  readonly scanned: ReadonlySet<number>;
  readonly results: ReadonlyMap<string, UrlResult>;
}

export const EMPTY_BUNDLE_SCAN: BundleScanState = {
  bundle: null,
  parts: 0,
  scanned: new Set(),
  results: new Map(),
};

export type BundleScanPlan =
  | {
      readonly kind: "redeem";
      /** The state this redeem adds to: the current codes' progress, or a fresh start. */
      readonly base: BundleScanState;
      readonly part: number;
      readonly parts: number;
      /** This code's hosts that have not paired yet. */
      readonly pairingUrls: ReadonlyArray<string>;
      /** After this code, every code has been scanned at least once. */
      readonly allScanned: boolean;
    }
  | { readonly kind: "done"; readonly part: number; readonly parts: number };

const isDone = (entry: UrlResult | undefined) =>
  entry !== undefined && entry.result._tag !== "Failed";

/**
 * What a scanned or pasted value asks for, or null when it is not a fleet code: several hosts, or
 * one code of several. A host that paired, or was already paired, is never redeemed again: its
 * link is spent or unused.
 */
export function planBundleScan(state: BundleScanState, value: string): BundleScanPlan | null {
  const link = value.trim();
  const pairingUrls = FleetPairing.readPairingBundle(link);
  if (pairingUrls === null) return null;
  const position = FleetPairing.readPairingBundlePart(link);
  if (position === null && pairingUrls.length < 2) return null;
  // A code with no part params is its own set; its tokens make the link unique.
  const { bundle, part, parts } = position ?? { bundle: link, part: 1, parts: 1 };
  const base: BundleScanState =
    state.bundle === bundle ? state : { ...EMPTY_BUNDLE_SCAN, bundle, parts };
  const remaining = pairingUrls.filter((url) => !isDone(base.results.get(url)));
  if (remaining.length === 0) return { kind: "done", part, parts };
  return {
    kind: "redeem",
    base,
    part,
    parts,
    pairingUrls: remaining,
    allScanned: new Set([...base.scanned, part]).size === parts,
  };
}

/** Results arrive in the order of the plan's pairing URLs. */
export function recordBundleScan(
  plan: Extract<BundleScanPlan, { kind: "redeem" }>,
  results: ReadonlyArray<FleetPairing.FleetRedeemResult>,
): BundleScanState {
  const merged = new Map(plan.base.results);
  plan.pairingUrls.forEach((url, index) => {
    const result = results[index];
    if (result !== undefined) merged.set(url, { part: plan.part, result });
  });
  return {
    ...plan.base,
    scanned: new Set([...plan.base.scanned, plan.part]),
    results: merged,
  };
}

export function bundleScanReport(state: BundleScanState): {
  readonly results: ReadonlyArray<FleetPairing.FleetRedeemResult>;
  /** The lowest code not scanned yet, or null once every code has been scanned. */
  readonly nextPart: number | null;
  /** Codes holding a host that failed, to scan again. */
  readonly failedParts: ReadonlyArray<number>;
} {
  const entries = [...state.results.values()];
  let nextPart: number | null = null;
  for (let part = state.parts; part >= 1; part -= 1) {
    if (!state.scanned.has(part)) nextPart = part;
  }
  return {
    results: entries.map((entry) => entry.result),
    nextPart,
    failedParts: [
      ...new Set(entries.flatMap((entry) => (entry.result._tag === "Failed" ? [entry.part] : []))),
    ].sort((a, b) => a - b),
  };
}
