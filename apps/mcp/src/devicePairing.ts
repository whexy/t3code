import { FleetPairing, mapRemoteEnvironmentError } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

import { pair } from "./access.ts";
import { Registry, upsertServer, type ServerRecord } from "./registry.ts";

export type DeviceHost =
  | { readonly _tag: "Minted"; readonly server: ServerRecord }
  | { readonly _tag: "Unavailable"; readonly server: ServerRecord; readonly detail: string };

export interface DevicePairing {
  /** Every minted server in one link, for pasting on a computer. Null when none minted. */
  readonly link: string | null;
  /** The same servers split into links that each fit a scannable QR code. */
  readonly codes: ReadonlyArray<string>;
  readonly expiresAtEpochMs: number | null;
  readonly hosts: ReadonlyArray<DeviceHost>;
}

/**
 * Mints a one-time pairing link on every enabled server with the bridge's token and bundles them
 * into the `t3code://pair` link T3 Code's own "Pair a device" makes, so any client redeems it.
 */
export const mintDevicePairing = Effect.fn("DevicePairing.mint")(function* () {
  const { servers } = yield* (yield* Registry).state;
  const results = yield* Effect.forEach(
    servers,
    (server) =>
      server.enabled
        ? FleetPairing.mintHostPairingUrl({
            httpBaseUrl: server.url,
            bearerToken: server.token,
          }).pipe(
            Effect.map((minted) => ({ server, ...minted })),
            Effect.catch((error) =>
              Effect.succeed({
                server,
                detail:
                  error._tag === "EnvironmentScopeRequiredError"
                    ? "The bridge's token here cannot create pairing links. Re-pair this server."
                    : error._tag === "EnvironmentAuthInvalidError"
                      ? "Token rejected. Re-pair this server."
                      : mapRemoteEnvironmentError(error).detail,
              }),
            ),
          )
        : Effect.succeed({ server, detail: "Disabled" }),
    { concurrency: "unbounded" },
  );
  const minted = results.flatMap((result) => ("pairingUrl" in result ? [result] : []));
  const pairingUrls = minted.map((result) => result.pairingUrl);
  return {
    link: minted.length === 0 ? null : FleetPairing.buildPairingBundleLink(pairingUrls),
    codes: FleetPairing.buildPairingBundleCodes(
      pairingUrls,
      Math.abs(yield* Random.nextInt).toString(36),
    ),
    expiresAtEpochMs:
      minted.length === 0 ? null : Math.min(...minted.map((result) => result.expiresAtEpochMs)),
    hosts: results.map((result): DeviceHost =>
      "pairingUrl" in result
        ? { _tag: "Minted", server: result.server }
        : { _tag: "Unavailable", server: result.server, detail: result.detail },
    ),
  } satisfies DevicePairing;
});

export type RedeemResult =
  | { readonly _tag: "Added" | "Refreshed"; readonly name: string; readonly id: string }
  | { readonly _tag: "Failed"; readonly name: string; readonly detail: string };

/**
 * Pairs with every server in the links. A server paired before gets the new token, so pasting a
 * fresh bundle from T3 Code renews every token at once.
 */
export const redeemPairingLinks = Effect.fn("DevicePairing.redeem")(function* (
  links: ReadonlyArray<string>,
  requestedId?: string,
) {
  const registry = yield* Registry;
  return yield* Effect.forEach(
    links,
    (link) =>
      pair(link).pipe(
        Effect.flatMap((pairing) => {
          let refreshed = false;
          return registry
            .update((current) => {
              refreshed = current.servers.some(
                (server) => server.environmentId === pairing.environmentId,
              );
              return upsertServer(current, pairing, requestedId);
            })
            .pipe(
              Effect.map((state): RedeemResult => ({
                _tag: refreshed ? "Refreshed" : "Added",
                name: pairing.name,
                id: state.servers.find((server) => server.environmentId === pairing.environmentId)!
                  .id,
              })),
            );
        }),
        Effect.catch((error) =>
          Effect.succeed<RedeemResult>({
            _tag: "Failed",
            name: hostOf(link),
            detail: error.message,
          }),
        ),
      ),
    { concurrency: "unbounded" },
  );
});

function hostOf(link: string) {
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}
