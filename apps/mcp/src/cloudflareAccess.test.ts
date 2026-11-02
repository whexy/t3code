import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

import { make } from "./cloudflareAccess.ts";

const TEAM_DOMAIN = "example.cloudflareaccess.com";
const AUDIENCE = "bridge-aud";

const accessKeys = await generateKeyPair("RS256");
const otherKeys = await generateKeyPair("RS256");
const access = make(
  { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
  createLocalJWKSet({
    keys: [{ ...(await exportJWK(accessKeys.publicKey)), kid: "access", alg: "RS256" }],
  }),
);

const assertion = (
  claims: { readonly iss?: string; readonly aud?: string; readonly exp?: string } = {},
  key: CryptoKey = accessKeys.privateKey,
) =>
  new SignJWT({ email: "owner@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "access" })
    .setIssuer(claims.iss ?? `https://${TEAM_DOMAIN}`)
    .setAudience([claims.aud ?? AUDIENCE])
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "5m")
    .sign(key);

describe("Cloudflare Access assertions", () => {
  it.effect("admits an assertion for this application", () =>
    Effect.gen(function* () {
      expect(yield* access.verify(yield* Effect.promise(() => assertion()))).toBe(true);
    }),
  );

  it.effect.each([
    ["malformed", () => Promise.resolve("not-a-jwt")],
    ["for another application", () => assertion({ aud: "another-application" })],
    ["from another team", () => assertion({ iss: "https://another.cloudflareaccess.com" })],
    ["expired", () => assertion({ exp: "1 minute ago" })],
    ["signed by another key", () => assertion({}, otherKeys.privateKey)],
  ] as const)("rejects an assertion that is %s", ([, sign]) =>
    Effect.gen(function* () {
      expect(yield* access.verify(yield* Effect.promise(sign))).toBe(false);
    }),
  );
});
