import {
  AuthAccessWriteScope,
  AuthGrantScope,
  type AuthGrantScopes,
  AuthStandardClientScopes,
  type EnvironmentId,
} from "@t3tools/contracts";
import { readPairingAppLink, resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as HttpClient from "effect/http/HttpClient";

import { bootstrapRemoteBearerSession, fetchRemoteSessionState } from "../authorization/remote.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import type { PreparedConnection } from "./model.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { connectionRoutes, credentialConnectionId } from "./routes.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";

const REQUEST_TIMEOUT_MS = 10_000;
// Sessions live 30 days. Renewing inside the last 14 keeps any client opened every two weeks paired.
export const RENEW_WITHIN_MS = 14 * 24 * 60 * 60 * 1000;
const RECHECK_AFTER_MS = 12 * 60 * 60 * 1000;
const SWEEP_INTERVAL = "1 hour";
const CONCURRENCY = 4;
const MINT_CONNECT_WAIT = "5 seconds";

const APP_LINK = "t3code://pair";
const PAIRING_URL_PARAM = "pairingUrl";
const PART_PARAM = "part";
const PARTS_PARAM = "parts";
const BUNDLE_PARAM = "bundle";
// About a version 14 QR code at low error correction, which a phone reads off a laptop screen.
export const MAX_QR_LINK_LENGTH = 450;

/**
 * One `t3code://pair` link for many hosts. It repeats the single-host link's parameter, so a
 * client that reads only one pairing URL still pairs with the first host.
 */
export function buildPairingBundleLink(pairingUrls: ReadonlyArray<string>): string {
  return `${APP_LINK}?${new URLSearchParams(pairingUrls.map((url) => [PAIRING_URL_PARAM, url]))}`;
}

/**
 * Splits the hosts across as few links as keep each under `maxLength`, so no QR code gets too
 * dense to scan. Each link of several names its place, so the scanner can ask for the next one.
 */
export function buildPairingBundleCodes(
  pairingUrls: ReadonlyArray<string>,
  bundleId: string,
  maxLength = MAX_QR_LINK_LENGTH,
): ReadonlyArray<string> {
  const groups: Array<Array<string>> = [];
  for (const url of pairingUrls) {
    const last = groups.at(-1);
    const partParams = `&${PART_PARAM}=99&${PARTS_PARAM}=99&${BUNDLE_PARAM}=${bundleId}`;
    if (
      last !== undefined &&
      buildPairingBundleLink([...last, url]).length + partParams.length <= maxLength
    ) {
      last.push(url);
    } else {
      groups.push([url]);
    }
  }
  if (groups.length <= 1) return groups.map(buildPairingBundleLink);
  return groups.map((group, index) => {
    const link = new URL(buildPairingBundleLink(group));
    link.searchParams.set(PART_PARAM, String(index + 1));
    link.searchParams.set(PARTS_PARAM, String(groups.length));
    link.searchParams.set(BUNDLE_PARAM, bundleId);
    return link.toString();
  });
}

/**
 * Which code of several a `t3code://pair` link is, or null when it stands alone. `bundle` is the
 * same on every code from one mint, so codes from different mints are never mixed up.
 */
export function readPairingBundlePart(
  value: string,
): { readonly bundle: string; readonly part: number; readonly parts: number } | null {
  if (readPairingBundle(value) === null) return null;
  const params = new URL(value.trim()).searchParams;
  const bundle = params.get(BUNDLE_PARAM) ?? "";
  const part = Number(params.get(PART_PARAM));
  const parts = Number(params.get(PARTS_PARAM));
  return bundle !== "" &&
    Number.isInteger(part) &&
    Number.isInteger(parts) &&
    part >= 1 &&
    part <= parts &&
    parts > 1
    ? { bundle, part, parts }
    : null;
}

/**
 * The pairing URL inside a `t3code://pair` link for one host, so it pairs the ordinary way (as a
 * route too). Any other value comes back unchanged.
 */
export function unwrapSingleHostLink(value: string): string {
  const pairingUrls = readPairingBundle(value);
  return pairingUrls?.length === 1 && readPairingBundlePart(value) === null
    ? pairingUrls[0]!
    : value;
}

/** Every pairing URL in a `t3code://pair` link, or null when the value is not one. */
export function readPairingBundle(value: string): ReadonlyArray<string> | null {
  const trimmed = value.trim();
  if (readPairingAppLink(trimmed) === null) return null;
  const urls = new URL(trimmed).searchParams
    .getAll(PAIRING_URL_PARAM)
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return urls.length > 0 ? [...new Set(urls)] : null;
}

function bearerSession(
  prepared: PreparedConnection,
): { readonly token: string; readonly connectionId: string } | null {
  return prepared.target._tag === "BearerConnectionTarget" &&
    prepared.httpAuthorization?._tag === "Bearer"
    ? { token: prepared.httpAuthorization.token, connectionId: prepared.target.connectionId }
    : null;
}

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isGrantScope = Schema.is(AuthGrantScope);

/** The address the user paired with. A learned route is one the new device learns by itself. */
function pairedHttpBaseUrl(entry: ConnectionCatalogEntry): string | null {
  for (const route of connectionRoutes(entry)) {
    const profile = Option.getOrUndefined(route.profile);
    if (isBearerProfile(profile) && profile.learned !== true && profile.authorization === undefined)
      return profile.httpBaseUrl;
  }
  return null;
}

/** Adds the address to labels that more than one host shares, so each row names one host. */
export function withDistinctLabels<T extends { readonly label: string }>(
  items: ReadonlyArray<{ readonly item: T; readonly address: string | null }>,
): Array<T> {
  const counts = new Map<string, number>();
  for (const { item } of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  return items.map(({ item, address }) =>
    (counts.get(item.label) ?? 0) > 1 && address !== null
      ? { ...item, label: `${item.label} (${address})` }
      : item,
  );
}

const hostOf = (httpBaseUrl: string | null) =>
  httpBaseUrl === null || !URL.canParse(httpBaseUrl) ? null : new URL(httpBaseUrl).host;

const issuePairingCredential = Effect.fn("clientRuntime.fleetPairing.issuePairingCredential")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
    readonly scopes?: AuthGrantScopes;
  }) {
    const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "auth");
    return yield* executeEnvironmentHttpRequest(
      environmentEndpointUrl(input.httpBaseUrl, "/api/auth/pairing-token"),
      REQUEST_TIMEOUT_MS,
      client.pairingCredential({
        headers: { authorization: `Bearer ${input.bearerToken}` },
        payload: input.scopes === undefined ? {} : { scopes: input.scopes },
      }),
    );
  },
);

/**
 * Delegates `scopes`. When they cover this build's whole standard set, the host's own standard set
 * is asked for first: a host newer than this client may grant scopes this build cannot name, and
 * listing only the known ones would narrow the new session for good. A refusal falls back to the list.
 */
const issueWithScopes = (
  input: { readonly httpBaseUrl: string; readonly bearerToken: string },
  scopes: AuthGrantScopes,
) => {
  const explicit = issuePairingCredential({ ...input, ...(scopes.length === 0 ? {} : { scopes }) });
  return AuthStandardClientScopes.every((scope) => scopes.includes(scope))
    ? issuePairingCredential(input).pipe(Effect.catch(() => explicit))
    : explicit;
};

function pairingUrl(httpBaseUrl: string, credential: string): string {
  const url = new URL("/pair", httpBaseUrl);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

/**
 * Mints a one-time pairing link on one host, delegating what the session holds of the standard
 * set (an older session may lack scopes added since). `pairingBaseUrl` is the address the link
 * should name when it differs from the one the request goes to.
 */
export const mintHostPairingUrl = Effect.fn("clientRuntime.fleetPairing.mintHostPairingUrl")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
    readonly pairingBaseUrl?: string;
  }) {
    const state = yield* fetchRemoteSessionState(input);
    const held = new Set(state.permissions ?? state.scopes ?? []);
    const issued = yield* issueWithScopes(
      input,
      AuthStandardClientScopes.filter((scope) => held.has(scope)),
    );
    return {
      pairingUrl: pairingUrl(input.pairingBaseUrl ?? input.httpBaseUrl, issued.credential),
      expiresAtEpochMs: issued.expiresAt.epochMilliseconds,
    };
  },
);

/**
 * Whether this client holds an authenticated session with the host, waiting up to `wait` for one
 * still connecting. A prepared connection is not enough: it exists while an attempt with an expired
 * token is still failing.
 */
const isConnected = Effect.fn("clientRuntime.fleetPairing.isConnected")(function* (
  environmentId: EnvironmentId,
  wait: Duration.Input,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  return yield* registry
    .run(
      environmentId,
      EnvironmentSupervisor.EnvironmentSupervisor.pipe(
        Effect.flatMap((supervisor) =>
          SubscriptionRef.changes(supervisor.session).pipe(
            Stream.filter(Option.isSome),
            Stream.runHead,
            Effect.timeoutOption(wait),
            Effect.map((session) => Option.isSome(Option.flatten(session))),
          ),
        ),
      ),
    )
    .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.succeed(false) }));
});

/** With `wait`, a host still connecting (say, just after launch) gets that long to come up. */
const livePrepared = Effect.fn("clientRuntime.fleetPairing.livePrepared")(function* (
  environmentId: EnvironmentId,
  wait?: Duration.Input,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  return yield* registry
    .run(
      environmentId,
      EnvironmentSupervisor.EnvironmentSupervisor.pipe(
        Effect.flatMap((supervisor) =>
          wait === undefined
            ? SubscriptionRef.get(supervisor.prepared)
            : SubscriptionRef.changes(supervisor.prepared).pipe(
                Stream.filter(Option.isSome),
                Stream.runHead,
                Effect.map(Option.flatten),
                Effect.timeoutOption(wait),
                Effect.map(Option.flatten),
              ),
        ),
      ),
    )
    .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.succeedNone }));
});

/**
 * Swaps a bearer session that expires soon for a fresh one minted by the same host. The old
 * session is left to expire, so another client sharing this credential keeps working until it
 * reads the new one.
 */
export const renewBearerCredentialIfDue = Effect.fn(
  "clientRuntime.fleetPairing.renewBearerCredentialIfDue",
)(function* (input: { readonly httpBaseUrl: string; readonly bearerToken: string }) {
  const session = yield* fetchRemoteSessionState(input);
  const now = yield* Clock.currentTimeMillis;
  if (
    !session.authenticated ||
    session.sessionMethod !== "bearer-access-token" ||
    session.expiresAt === undefined ||
    session.expiresAt.epochMilliseconds - now > RENEW_WITHIN_MS
  ) {
    return Option.none<string>();
  }
  const granted = session.permissions ?? session.scopes;
  // Minting another session needs access:write; without it renewal can only fail.
  if (granted !== undefined && !granted.includes(AuthAccessWriteScope))
    return Option.none<string>();
  const presentation = yield* ClientCapabilities.ClientPresentation;
  // The exact grant (`scopes` is the older, coarser vocabulary), so the renewed session is no
  // wider or narrower than this one. Older servers send only `scopes`.
  const issued = yield* issueWithScopes(input, granted?.filter(isGrantScope) ?? []);
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: input.httpBaseUrl,
    credential: issued.credential,
    clientMetadata: presentation.metadata,
  });
  return Option.some(access.access_token);
});

/**
 * One host's renewal check, holding what it learned across calls: when each credential was last
 * checked, and which tokens were already replaced while their connection stays open.
 */
export const makeBearerRenewalCheck = Effect.fn(
  "clientRuntime.fleetPairing.makeBearerRenewalCheck",
)(function* () {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const checkedAt = new Map<string, number>();
  // The open connection keeps its old token until it reconnects; that token must not renew again.
  const replaced = new Set<string>();
  // A renewed token whose save failed; the next check saves it again instead of minting another.
  const unsaved = new Map<string, string>();

  const save = (credentialId: string, oldToken: string, token: string) =>
    credentials.put(credentialId, new BearerConnectionCredential({ token })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          unsaved.delete(credentialId);
          replaced.add(oldToken);
        }),
      ),
      Effect.tapError(() => Effect.sync(() => unsaved.set(credentialId, token))),
    );

  // Untraced: a check per connection open and per hour per host would bury real spans.
  const check = Effect.fnUntraced(function* (prepared: PreparedConnection) {
    const session = bearerSession(prepared);
    if (session === null || replaced.has(session.token)) return;
    const credentialId = credentialConnectionId(session.connectionId);
    const pending = unsaved.get(credentialId);
    if (pending !== undefined) {
      yield* save(credentialId, session.token, pending);
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    const lastChecked = checkedAt.get(credentialId);
    if (lastChecked !== undefined && now - lastChecked < RECHECK_AFTER_MS) return;
    checkedAt.set(credentialId, now);
    // Another window or device sharing this catalog may have renewed it already, or moved it
    // to a device-bound credential the host renews itself.
    const stored = Option.getOrUndefined(yield* credentials.get(credentialId));
    if (
      stored !== undefined &&
      (stored._tag !== "BearerConnectionCredential" || stored.token !== session.token)
    ) {
      replaced.add(session.token);
      return;
    }
    const renewed = yield* renewBearerCredentialIfDue({
      httpBaseUrl: prepared.httpBaseUrl,
      bearerToken: session.token,
    }).pipe(Effect.tapError(() => Effect.sync(() => checkedAt.delete(credentialId))));
    if (Option.isNone(renewed)) return;
    yield* save(credentialId, session.token, renewed.value);
  });

  return check;
});

/**
 * Renews each connected host's bearer credential when it nears expiry: as soon as a connection
 * opens, so a brief visit is enough, and hourly while it stays open. Runs until interrupted.
 */
export const watchBearerRenewals = Effect.fn("clientRuntime.fleetPairing.watchBearerRenewals")(
  function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const check = yield* makeBearerRenewalCheck();

    const checkLogged = (environmentId: EnvironmentId, prepared: PreparedConnection) =>
      check(prepared).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not renew the environment's credential.", {
            environmentId,
            error,
          }),
        ),
      );

    const follow = (environmentId: EnvironmentId) =>
      registry
        .followStream(
          environmentId,
          Stream.unwrap(
            EnvironmentSupervisor.EnvironmentSupervisor.pipe(
              Effect.map((supervisor) => SubscriptionRef.changes(supervisor.prepared)),
            ),
          ),
        )
        .pipe(
          Stream.runForEach((prepared) =>
            Option.isSome(prepared) ? checkLogged(environmentId, prepared.value) : Effect.void,
          ),
        );

    const followed = new Map<EnvironmentId, Fiber.Fiber<void>>();
    const followEntries = Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(registry.entries)),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.runForEach((entries) =>
        Effect.gen(function* () {
          for (const environmentId of entries.keys()) {
            if (!followed.has(environmentId))
              followed.set(environmentId, yield* Effect.forkChild(follow(environmentId)));
          }
          for (const [environmentId, fiber] of followed) {
            if (entries.has(environmentId)) continue;
            followed.delete(environmentId);
            yield* Fiber.interrupt(fiber);
          }
        }),
      ),
    );

    const sweep = Effect.gen(function* () {
      const entries = yield* SubscriptionRef.get(registry.entries);
      yield* Effect.forEach(
        entries.keys(),
        (environmentId) =>
          livePrepared(environmentId).pipe(
            Effect.flatMap((prepared) =>
              Option.isSome(prepared) ? checkLogged(environmentId, prepared.value) : Effect.void,
            ),
          ),
        { concurrency: CONCURRENCY, discard: true },
      );
    });

    yield* Effect.forkChild(followEntries);
    return yield* Effect.forever(Effect.andThen(Effect.sleep(SWEEP_INTERVAL), sweep));
  },
);

export type FleetHostPairing =
  | {
      readonly _tag: "Minted";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly pairingUrl: string;
      readonly expiresAtEpochMs: number;
    }
  | {
      readonly _tag: "Unavailable";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly detail: string;
    };

export interface FleetPairing {
  /** Every minted host in one link, for copying. Null when no host minted a link. */
  readonly link: string | null;
  /** The same hosts split into links that each fit a scannable QR code; shown one at a time. */
  readonly codes: ReadonlyArray<string>;
  /** The earliest expiry among the minted links. */
  readonly expiresAtEpochMs: number | null;
  readonly hosts: ReadonlyArray<FleetHostPairing>;
}

/**
 * Mints a one-time pairing link on every saved host this client is connected to with a bearer
 * session, and bundles them into one link another device can redeem.
 */
export const mintFleetPairing = Effect.fn("clientRuntime.fleetPairing.mint")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const entries = [...(yield* SubscriptionRef.get(registry.entries)).values()].filter(
    (entry) => entry.target._tag === "BearerConnectionTarget",
  );
  const hosts = yield* Effect.forEach(
    entries,
    Effect.fnUntraced(function* (entry): Effect.fn.Return<
      FleetHostPairing,
      never,
      HttpClient.HttpClient | EnvironmentRegistry.EnvironmentRegistry
    > {
      const environmentId = entry.target.environmentId;
      const label = entry.target.label;
      const prepared = Option.getOrUndefined(
        yield* livePrepared(environmentId, entry.enabled ? MINT_CONNECT_WAIT : undefined),
      );
      const session = prepared === undefined ? null : bearerSession(prepared);
      if (prepared === undefined || session === null) {
        return {
          _tag: "Unavailable",
          environmentId,
          label,
          detail: entry.enabled ? "Not connected" : "Turned off",
        };
      }
      const pairingBaseUrl = pairedHttpBaseUrl(entry);
      return yield* mintHostPairingUrl({
        httpBaseUrl: prepared.httpBaseUrl,
        bearerToken: session.token,
        ...(pairingBaseUrl === null ? {} : { pairingBaseUrl }),
      }).pipe(
        Effect.map((minted): FleetHostPairing => ({
          _tag: "Minted",
          environmentId,
          label,
          ...minted,
        })),
        Effect.catch((error) =>
          Effect.succeed<FleetHostPairing>({
            _tag: "Unavailable",
            environmentId,
            label,
            detail: mapRemoteEnvironmentError(error).detail,
          }),
        ),
      );
    }),
    { concurrency: "unbounded" },
  );
  const minted = hosts.flatMap((host) => (host._tag === "Minted" ? [host] : []));
  const pairingUrls = minted.map((host) => host.pairingUrl);
  return {
    link: minted.length === 0 ? null : buildPairingBundleLink(pairingUrls),
    codes: buildPairingBundleCodes(pairingUrls, Math.abs(yield* Random.nextInt).toString(36)),
    expiresAtEpochMs:
      minted.length === 0 ? null : Math.min(...minted.map((host) => host.expiresAtEpochMs)),
    hosts: withDistinctLabels(
      hosts.map((item, index) => ({ item, address: hostOf(pairedHttpBaseUrl(entries[index]!)) })),
    ).sort((a, b) => a.label.localeCompare(b.label)),
  } satisfies FleetPairing;
});

export type FleetRedeemResult =
  | { readonly _tag: "Paired"; readonly label: string; readonly environmentId: EnvironmentId }
  | {
      readonly _tag: "AlreadyPaired";
      readonly label: string;
      readonly environmentId: EnvironmentId;
    }
  | { readonly _tag: "Failed"; readonly label: string; readonly detail: string };

export interface FleetRedeemSummary {
  readonly outcome: "paired" | "partial" | "failed";
  readonly title: string;
  readonly paired: ReadonlyArray<string>;
  /** One "label: reason." line per host that failed. */
  readonly failures: ReadonlyArray<string>;
  /** "Already paired: …" when any host was, else null. */
  readonly alreadyNote: string | null;
  /** `failures` then `alreadyNote`, for surfaces that show them together. */
  readonly details: ReadonlyArray<string>;
}

const sentence = (text: string) => (/[.!?]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const environments = (count: number) => `${count} environment${count === 1 ? "" : "s"}`;

export function summarizeFleetRedeem(
  results: ReadonlyArray<FleetRedeemResult>,
): FleetRedeemSummary {
  const paired = results.flatMap((result) => (result._tag === "Paired" ? [result.label] : []));
  const already = results.flatMap((result) =>
    result._tag === "AlreadyPaired" ? [result.label] : [],
  );
  const failed = results.flatMap((result) => (result._tag === "Failed" ? [result] : []));
  const failures = failed.map((result) => `${result.label}: ${sentence(result.detail)}`);
  // With nothing paired or failed, the title already says every host was already paired.
  const alreadyNote =
    already.length > 0 && (paired.length > 0 || failed.length > 0)
      ? `Already paired: ${already.join(", ")}.`
      : null;
  const attempted = results.length - already.length;
  const outcome =
    failed.length === 0 ? "paired" : paired.length + already.length === 0 ? "failed" : "partial";
  const only = results.length === 1 ? results[0] : undefined;
  const title =
    only !== undefined
      ? only._tag === "Paired"
        ? `Paired ${only.label}`
        : only._tag === "AlreadyPaired"
          ? `Already paired with ${only.label}`
          : `Could not pair ${only.label}`
      : failed.length > 0
        ? paired.length === 0
          ? `Could not pair ${environments(failed.length)}`
          : `Paired ${paired.length} of ${environments(attempted)}`
        : paired.length === 0
          ? `Already paired with all ${environments(already.length)}`
          : `Paired ${environments(paired.length)}`;
  // A single host's title already says everything but a failure's reason.
  const single = only !== undefined;
  const shownNote = single ? null : alreadyNote;
  return {
    outcome,
    title,
    paired,
    failures,
    alreadyNote: shownNote,
    details: [...failures, ...(shownNote === null ? [] : [shownNote])],
  };
}

function pairingHttpBaseUrl(pairingUrl: string): string | null {
  try {
    return resolveRemotePairingTarget({ pairingUrl }).httpBaseUrl;
  } catch {
    return null;
  }
}

/**
 * Pairs with every host in a bundle. A host this client already reaches is left alone, its link
 * unspent. A host saved here but not reachable, say because its session expired, is paired again
 * under its saved entry instead of refusing the address.
 */
export const redeemFleetPairing = Effect.fn("clientRuntime.fleetPairing.redeem")(function* (
  pairingUrls: ReadonlyArray<string>,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
  const results = yield* Effect.forEach(
    pairingUrls,
    Effect.fnUntraced(function* (url): Effect.fn.Return<
      FleetRedeemResult,
      never,
      HttpClient.HttpClient | EnvironmentRegistry.EnvironmentRegistry
    > {
      const httpBaseUrl = pairingHttpBaseUrl(url);
      const descriptor =
        httpBaseUrl === null
          ? Option.none()
          : yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(Effect.option);
      if (Option.isNone(descriptor)) {
        return {
          _tag: "Failed",
          label: httpBaseUrl === null ? url : new URL(httpBaseUrl).host,
          detail: httpBaseUrl === null ? "Not a pairing link" : "Could not reach this environment",
        };
      }
      const label = descriptor.value.label;
      const saved = (yield* SubscriptionRef.get(registry.entries)).has(
        descriptor.value.environmentId,
      );
      if (saved) {
        const environmentId = descriptor.value.environmentId;
        if (yield* isConnected(environmentId, MINT_CONNECT_WAIT)) {
          return { _tag: "AlreadyPaired", label, environmentId };
        }
      }
      return yield* onboarding
        .registerPairing({
          pairingUrl: url,
          ...(saved ? { expectedEnvironmentId: descriptor.value.environmentId } : {}),
        })
        .pipe(
          Effect.map((environmentId): FleetRedeemResult => ({
            _tag: "Paired",
            label,
            environmentId,
          })),
          Effect.catch((error) =>
            Effect.succeed<FleetRedeemResult>({
              _tag: "Failed",
              label,
              detail:
                error._tag === "ConnectionBlockedError" && error.reason === "authentication"
                  ? "This pairing link was already used or has expired"
                  : error.message,
            }),
          ),
        );
    }),
    { concurrency: "unbounded" },
  );
  return withDistinctLabels(
    results.map((item, index) => ({
      item,
      address: hostOf(pairingHttpBaseUrl(pairingUrls[index]!)),
    })),
  );
});
