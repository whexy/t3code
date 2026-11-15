import { FleetPairing } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "./runtime";

const fleetPairingScheduler = createAtomCommandScheduler();

export const mintFleetPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:mint-fleet-pairing",
  scheduler: fleetPairingScheduler,
  execute: (_: void) => FleetPairing.mintFleetPairing(),
});

export const redeemFleetPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:redeem-fleet-pairing",
  scheduler: fleetPairingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (pairingUrls: ReadonlyArray<string>) => JSON.stringify(pairingUrls),
  },
  execute: (pairingUrls: ReadonlyArray<string>) => FleetPairing.redeemFleetPairing(pairingUrls),
});
