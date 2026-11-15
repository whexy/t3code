import { describe, expect, it } from "@effect/vitest";
import { AuthStandardClientScopes, EnvironmentId } from "@t3tools/contracts";
import { readPairingAppLink } from "@t3tools/shared/remote";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcHttp from "../rpc/http.ts";
import { BearerConnectionCredential, type ConnectionCredential } from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  type PreparedConnection,
} from "./model.ts";
import {
  buildPairingBundleCodes,
  buildPairingBundleLink,
  MAX_QR_LINK_LENGTH,
  readPairingBundle,
  readPairingBundlePart,
  renewBearerCredentialIfDue,
  makeBearerRenewalCheck,
  summarizeFleetRedeem,
  unwrapSingleHostLink,
  withDistinctLabels,
  RENEW_WITHIN_MS,
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

const NOW = 0;
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function layerHost(input: {
  readonly expiresInMs: number;
  readonly calls: Array<string>;
  readonly bodies?: Array<string>;
  readonly permissions?: ReadonlyArray<string>;
  readonly sessionMethod?: string;
}) {
  const fetchFn = ((request: RequestInfo | URL, init?: RequestInit) => {
    const url = request instanceof Request ? request.url : request.toString();
    input.calls.push(new URL(url).pathname);
    if (url.endsWith("/api/auth/pairing-token")) input.bodies?.push(String(init?.body));
    if (url.endsWith("/api/auth/session")) {
      return Promise.resolve(
        Response.json({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "t3_session",
          },
          scopes: ["orchestration:read"],
          permissions: input.permissions ?? [
            "orchestration:read",
            "filesystem:read",
            "review:write",
            "access:write",
          ],
          sessionMethod: input.sessionMethod ?? "bearer-access-token",
          expiresAt: isoAt(NOW + input.expiresInMs),
        }),
      );
    }
    if (url.endsWith("/api/auth/pairing-token")) {
      return Promise.resolve(
        Response.json({
          id: "link-1",
          credential: "fresh-pairing-code",
          expiresAt: isoAt(NOW + 5 * 60_000),
        }),
      );
    }
    if (url.endsWith("/oauth/token")) {
      return Promise.resolve(
        Response.json({
          access_token: "fresh-session-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 30 * 24 * 60 * 60,
          scope: "orchestration:read",
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;
  return Layer.mergeAll(
    RpcHttp.layerRemoteHttpClient(fetchFn),
    Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({ metadata: { label: "Test client" } }),
    ),
  );
}

const renew = renewBearerCredentialIfDue({
  httpBaseUrl: "https://deimos-t3.example.test/",
  bearerToken: "old-session-token",
});

describe("bearer credential renewal", () => {
  it.effect("swaps a session inside the renewal window for one minted with its own scopes", () => {
    const calls: Array<string> = [];
    const bodies: Array<string> = [];
    return renew.pipe(
      Effect.tap((renewed) =>
        Effect.sync(() => {
          expect(renewed).toEqual(Option.some("fresh-session-token"));
          expect(calls).toEqual(["/api/auth/session", "/api/auth/pairing-token", "/oauth/token"]);
          expect(bodies.map((body) => JSON.parse(body))).toEqual([
            { scopes: ["orchestration:read", "filesystem:read", "access:write"] },
          ]);
        }),
      ),
      Effect.provide(layerHost({ expiresInMs: RENEW_WITHIN_MS - 1, calls, bodies })),
    );
  });

  it.effect(
    "asks for the host's own standard set when the session holds all of this build's",
    () => {
      const calls: Array<string> = [];
      const bodies: Array<string> = [];
      return renew.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(bodies.map((body) => JSON.parse(body))).toEqual([{}]);
          }),
        ),
        Effect.provide(
          layerHost({
            expiresInMs: RENEW_WITHIN_MS - 1,
            calls,
            bodies,
            permissions: [...AuthStandardClientScopes],
          }),
        ),
      );
    },
  );

  it.effect("leaves a session with time to spare alone", () => {
    const calls: Array<string> = [];
    return renew.pipe(
      Effect.tap((renewed) =>
        Effect.sync(() => {
          expect(renewed).toEqual(Option.none());
          expect(calls).toEqual(["/api/auth/session"]);
        }),
      ),
      Effect.provide(layerHost({ expiresInMs: RENEW_WITHIN_MS + 1, calls })),
    );
  });

  it.effect("does not try to renew a session that cannot mint", () => {
    const calls: Array<string> = [];
    return renew.pipe(
      Effect.tap((renewed) =>
        Effect.sync(() => {
          expect(renewed).toEqual(Option.none());
          expect(calls).toEqual(["/api/auth/session"]);
        }),
      ),
      Effect.provide(layerHost({ expiresInMs: 1, calls, permissions: ["orchestration:read"] })),
    );
  });

  it.effect("does not renew a session that is not a bearer token", () => {
    const calls: Array<string> = [];
    return renew.pipe(
      Effect.tap((renewed) =>
        Effect.sync(() => {
          expect(renewed).toEqual(Option.none());
          expect(calls).toEqual(["/api/auth/session"]);
        }),
      ),
      Effect.provide(layerHost({ expiresInMs: 1, calls, sessionMethod: "browser-session-cookie" })),
    );
  });
});

const RENEWED_TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("deimos"),
  label: "deimos",
  connectionId: "bearer:deimos:https://deimos-t3.example.test",
});

const preparedWith = (token: string): PreparedConnection => ({
  environmentId: RENEWED_TARGET.environmentId,
  label: "deimos",
  httpBaseUrl: "https://deimos-t3.example.test/",
  socketUrl: "wss://deimos-t3.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token },
  target: RENEWED_TARGET,
});

describe("bearer renewal watcher", () => {
  it.effect("renews an open connection once, even though it keeps its old token", () => {
    const calls: Array<string> = [];
    const stored = new Map<string, ConnectionCredential>([
      [RENEWED_TARGET.connectionId, new BearerConnectionCredential({ token: "old-session-token" })],
    ]);
    const store = Layer.succeed(
      ConnectionCredentialStore.ConnectionCredentialStore,
      ConnectionCredentialStore.make({
        get: (id) => Effect.succeed(Option.fromUndefinedOr(stored.get(id))),
        put: (id, credential) => Effect.sync(() => void stored.set(id, credential)),
        remove: (id) => Effect.sync(() => void stored.delete(id)),
      }),
    );
    return Effect.gen(function* () {
      const check = yield* makeBearerRenewalCheck();
      yield* check(preparedWith("old-session-token"));
      expect(stored.get(RENEWED_TARGET.connectionId)).toEqual(
        new BearerConnectionCredential({ token: "fresh-session-token" }),
      );
      const mints = () => calls.filter((path) => path === "/api/auth/pairing-token").length;
      expect(mints()).toBe(1);

      // The open connection still reports the old token past the recheck interval.
      yield* TestClock.adjust("13 hours");
      yield* check(preparedWith("old-session-token"));
      expect(mints()).toBe(1);
    }).pipe(Effect.provide(Layer.merge(layerHost({ expiresInMs: 1, calls }), store)));
  });

  it.effect("saves a renewed token again after a failed save, without minting another", () => {
    const calls: Array<string> = [];
    const stored = new Map<string, ConnectionCredential>();
    let failNextPut = true;
    const store = Layer.succeed(
      ConnectionCredentialStore.ConnectionCredentialStore,
      ConnectionCredentialStore.make({
        get: (id) => Effect.succeed(Option.fromUndefinedOr(stored.get(id))),
        put: (id, credential) =>
          failNextPut
            ? Effect.sync(() => {
                failNextPut = false;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ConnectionTransientError({ reason: "remote-unavailable", detail: "412" }),
                  ),
                ),
              )
            : Effect.sync(() => void stored.set(id, credential)),
        remove: (id) => Effect.sync(() => void stored.delete(id)),
      }),
    );
    return Effect.gen(function* () {
      const check = yield* makeBearerRenewalCheck();
      yield* check(preparedWith("old-session-token")).pipe(Effect.ignore);
      expect(stored.size).toBe(0);
      yield* check(preparedWith("old-session-token"));
      expect(stored.get(RENEWED_TARGET.connectionId)).toEqual(
        new BearerConnectionCredential({ token: "fresh-session-token" }),
      );
      expect(calls.filter((path) => path === "/api/auth/pairing-token")).toHaveLength(1);
    }).pipe(Effect.provide(Layer.merge(layerHost({ expiresInMs: 1, calls }), store)));
  });
});
