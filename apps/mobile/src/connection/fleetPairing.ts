import { FleetPairing } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "./runtime";

/** Mints a fresh bundle each time a reader mounts it or refreshes it. */
export const fleetPairingAtom = connectionAtomRuntime
  .atom(FleetPairing.mintFleetPairing())
  .pipe(Atom.withLabel("mobile:connection:fleet-pairing"));

export const redeemFleetPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:redeem-fleet-pairing",
  execute: (pairingUrls: ReadonlyArray<string>) => FleetPairing.redeemFleetPairing(pairingUrls),
});
