import { FleetPairing } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { redeemFleetPairing } from "../connection/fleetPairing";
import { useAtomCommand } from "../state/use-atom-command";

type RedeemSummary = Pick<FleetPairing.FleetRedeemSummary, "outcome" | "title" | "details">;

/**
 * The pairing URLs of a link that needs the fleet path: several hosts, or one code of several.
 * A lone single-host link stays on the single-host path, which can pair it as a route.
 */
function readFleetBundle(value: string): ReadonlyArray<string> | null {
  const pairingUrls = FleetPairing.readPairingBundle(value);
  if (pairingUrls === null) return null;
  return pairingUrls.length > 1 || FleetPairing.readPairingBundlePart(value) !== null
    ? pairingUrls
    : null;
}

function useRedeemAll() {
  const redeem = useAtomCommand(redeemFleetPairing, { reportFailure: false });
  return async (pairingUrls: ReadonlyArray<string>): Promise<RedeemSummary | null> => {
    const result = await redeem(pairingUrls);
    if (result._tag === "Success") return FleetPairing.summarizeFleetRedeem(result.value);
    if (isAtomCommandInterrupted(result)) return null;
    const error = squashAtomCommandFailure(result);
    return {
      outcome: "failed",
      title: "Could not add environments",
      details: [error instanceof Error ? error.message : "Pairing failed."],
    };
  };
}

function toastSummary(summary: RedeemSummary) {
  toastManager.add(
    stackedThreadToast({
      type:
        summary.outcome === "paired"
          ? "success"
          : summary.outcome === "partial"
            ? "warning"
            : "error",
      title: summary.title,
      ...(summary.details.length > 0
        ? {
            description: <span className="whitespace-pre-line">{summary.details.join("\n")}</span>,
          }
        : {}),
    }),
  );
}

/**
 * Pairs every host in a fleet link typed into Add environment. Resolves false when the value is
 * not one, so the dialog reads it as a single host. `onPaired` runs unless every host failed.
 */
export function useRedeemPastedPairingBundle() {
  const redeemAll = useRedeemAll();
  return async (
    value: string,
    dialog: {
      readonly setBusy: (busy: boolean) => void;
      readonly onError: (error: string | null) => void;
      readonly onPaired: () => void;
      /** Adding a route to one saved environment, which a fleet link cannot do. */
      readonly addingRoute: boolean;
    },
  ): Promise<boolean> => {
    const pairingUrls = readFleetBundle(value);
    if (pairingUrls === null) return false;
    if (dialog.addingRoute) {
      dialog.onError(
        "This link pairs several environments. To add a route, use one environment's own pairing link.",
      );
      return true;
    }
    dialog.setBusy(true);
    dialog.onError(null);
    const summary = await redeemAll(pairingUrls);
    dialog.setBusy(false);
    if (summary === null) return true;
    if (summary.outcome === "failed") {
      dialog.onError([`${summary.title}.`, ...summary.details].join(" "));
      return true;
    }
    dialog.onPaired();
    toastSummary(summary);
    return true;
  };
}

function originOf(pairingUrl: string): string {
  try {
    return new URL(resolveRemotePairingTarget({ pairingUrl }).httpBaseUrl).origin;
  } catch {
    return pairingUrl;
  }
}

/**
 * Opens a fleet `t3code://pair` link. Resolves false for a lone single-host link, which the
 * caller pairs on its own path.
 */
export function useOpenPairingBundleLink() {
  const redeemAll = useRedeemAll();
  return async (url: string): Promise<boolean> => {
    const pairingUrls = readFleetBundle(url);
    if (pairingUrls === null) return false;
    // Any page can open this link, so the user confirms the hosts before their one-time tokens are spent.
    const confirmed =
      (await requestConfirmDialog(
        `Add ${pairingUrls.length === 1 ? "1 environment" : `${pairingUrls.length} environments`}?\n${pairingUrls.map(originOf).join("\n")}`,
      )) ?? false;
    if (!confirmed) return true;
    const summary = await redeemAll(pairingUrls);
    if (summary !== null) toastSummary(summary);
    return true;
  };
}
