import { FleetPairing } from "@t3tools/client-runtime/connection";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { AccessibilityInfo, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { PairingOutcome } from "../../state/use-remote-environment-registry";
import {
  EMPTY_BUNDLE_SCAN,
  type BundleScanPlan,
  bundleScanReport,
  planBundleScan,
  recordBundleScan,
} from "./fleetPairingScan";
import { alertFleetRedeem, runFleetRedeem } from "./fleetPairingRedeem";

const REDEEM_FAILED = "Failed to pair with the environments.";

interface FleetScanStatus {
  readonly message: string;
  readonly failures: ReadonlyArray<string>;
  readonly note: string | null;
}

function detailLines(results: ReadonlyArray<FleetPairing.FleetRedeemResult>) {
  const summary = FleetPairing.summarizeFleetRedeem(results);
  return {
    failures: summary.failures,
    note: summary.alreadyNote,
  };
}

type RedeemPlan = Extract<BundleScanPlan, { kind: "redeem" }>;

const codeName = (part: number, parts: number) =>
  parts > 1 ? `code ${part} of ${parts}` : "this code";

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function retryHint(failedParts: ReadonlyArray<number>, parts: number): string {
  if (parts === 1) return "Scan or paste the code again to retry.";
  const codes = failedParts.join(", ");
  return `Scan code${failedParts.length > 1 ? "s" : ""} ${codes} again to retry.`;
}

/**
 * Pairs from fleet codes scanned or pasted on the Add environment screen. Each code pairs as it is
 * scanned; once every code has been scanned, a run with no failures left hands its outcome to
 * `finish`, so the screen leaves the way it does after a single pairing. With failures left the
 * screen stays, and scanning a failed code again retries only its failed hosts.
 */
export function useFleetPairingScan(onLinkUsed: () => void, addingRoute: boolean) {
  const state = useRef(EMPTY_BUNDLE_SCAN);
  // The camera reports a code several times a second; one redeem runs at a time.
  const busy = useRef(false);
  const [status, setShownStatus] = useState<FleetScanStatus | null>(null);
  // accessibilityLiveRegion is Android-only; iOS VoiceOver hears the progress through this.
  const setStatus = (next: FleetScanStatus | null) => {
    setShownStatus(next);
    if (next !== null) AccessibilityInfo.announceForAccessibility(next.message);
  };

  const redeem = async (plan: RedeemPlan) => {
    if (plan.parts > 1) {
      setStatus({
        message: `Pairing ${codeName(plan.part, plan.parts)}…`,
        failures: [],
        note: null,
      });
    }
    const results = await runFleetRedeem(plan.pairingUrls);
    busy.current = false;
    if (results === null) return null;
    state.current = recordBundleScan(plan, results);
    const report = bundleScanReport(state.current);
    if (results.every((result) => result._tag !== "Failed")) onLinkUsed();
    return { results, report };
  };

  const redeemPart = async (plan: RedeemPlan) => {
    const redeemed = await redeem(plan);
    if (redeemed === null) {
      setStatus({
        message: `Couldn't pair ${codeName(plan.part, plan.parts)}. Scan it again.`,
        failures: [],
        note: null,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    const summary = FleetPairing.summarizeFleetRedeem(redeemed.results);
    setStatus({
      message: `${summary.title} from ${codeName(plan.part, plan.parts)}. Scan code ${redeemed.report.nextPart}.`,
      ...detailLines(redeemed.report.results),
    });
    void Haptics.notificationAsync(
      summary.outcome === "failed"
        ? Haptics.NotificationFeedbackType.Error
        : Haptics.NotificationFeedbackType.Success,
    );
  };

  const redeemLast = async (plan: RedeemPlan): Promise<PairingOutcome> => {
    const redeemed = await redeem(plan);
    if (redeemed === null) {
      setStatus(null);
      return { ok: false, error: REDEEM_FAILED };
    }
    const { results, failedParts } = redeemed.report;
    if (failedParts.length === 0) {
      setStatus(null);
      alertFleetRedeem(results);
      return { ok: true, error: null };
    }
    const summary = FleetPairing.summarizeFleetRedeem(results);
    setStatus({
      message: `${summary.title}. ${retryHint(failedParts, plan.parts)}`,
      ...detailLines(results),
    });
    return { ok: false, error: null };
  };

  /** False when the value is not a fleet code, so the screen pairs it the ordinary way. */
  const take = (
    value: string,
    finish: (redeem: () => Promise<PairingOutcome>) => unknown,
  ): boolean => {
    const plan = planBundleScan(state.current, value);
    if (plan === null) return false;
    if (busy.current) return true;
    if (addingRoute) {
      setStatus({
        message:
          "This link pairs several environments. To add a route, use one environment's own pairing link.",
        failures: [],
        note: null,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return true;
    }
    if (plan.kind === "done") {
      setStatus({
        message: `${capitalize(codeName(plan.part, plan.parts))} is already done.`,
        failures: [],
        note: null,
      });
      onLinkUsed();
      return true;
    }
    busy.current = true;
    if (plan.allScanned) finish(() => redeemLast(plan));
    else void redeemPart(plan);
    return true;
  };

  return { take, status };
}

export function FleetPairingScanStatus(props: { readonly status: FleetScanStatus | null }) {
  if (props.status === null) return null;
  return (
    <View className="gap-1 px-4" accessibilityLiveRegion="polite">
      <Text className="text-sm leading-normal text-foreground">{props.status.message}</Text>
      {props.status.failures.map((failure) => (
        <Text key={failure} className="text-sm leading-normal text-danger-foreground">
          {failure}
        </Text>
      ))}
      {props.status.note === null ? null : (
        <Text className="text-sm leading-normal text-foreground-muted">{props.status.note}</Text>
      )}
    </View>
  );
}
