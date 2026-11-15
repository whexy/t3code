import { FleetPairing } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import * as Dialog from "../../components/ui/Dialog";
import { redeemFleetPairing } from "../../connection/fleetPairing";
import { appAtomRegistry } from "../../state/atom-registry";

/** Each host's result, or null when the redeem itself could not run. */
export async function runFleetRedeem(
  pairingUrls: ReadonlyArray<string>,
): Promise<ReadonlyArray<FleetPairing.FleetRedeemResult> | null> {
  const result = await runAtomCommand(appAtomRegistry, redeemFleetPairing, pairingUrls);
  return AsyncResult.isSuccess(result) ? result.value : null;
}

export function alertFleetRedeem(results: ReadonlyArray<FleetPairing.FleetRedeemResult>): void {
  const summary = FleetPairing.summarizeFleetRedeem(results);
  const pairedLine = summary.paired.length > 1 ? [summary.paired.join(", ")] : [];
  const message = [...pairedLine, ...summary.details].join("\n");
  Dialog.alert(summary.title, message === "" ? undefined : message);
}
