import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** The Cloudflare Access application in front of the public MCP endpoint. */
export interface AccessApplication {
  /** Zero Trust team domain, such as `example.cloudflareaccess.com`. */
  readonly teamDomain: string;
  /** AUD tag of the Access application covering the MCP hostname. */
  readonly audience: string;
}

export class CloudflareAccess extends Context.Service<
  CloudflareAccess,
  {
    /** Whether a `Cf-Access-Jwt-Assertion` value was signed by Access for this application. */
    readonly verify: (assertion: string) => Effect.Effect<boolean>;
  }
>()("@t3tools/mcp/cloudflareAccess") {}

/** `keys` defaults to the team's published signing keys. */
export const make = (application: AccessApplication, keys?: JWTVerifyGetKey) => {
  const issuer = `https://${application.teamDomain}`;
  // jose caches the keys and refetches when an assertion names one it has not
  // seen, which is how Access rotates them.
  const getKey = keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return CloudflareAccess.of({
    verify: (assertion) =>
      Effect.tryPromise(() =>
        jwtVerify(assertion, getKey, {
          issuer,
          audience: application.audience,
          algorithms: ["RS256"],
        }),
      ).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning(`Rejected a Cloudflare Access assertion: ${error.cause}`).pipe(
            Effect.as(false),
          ),
        ),
      ),
  });
};

export const layer = (application: AccessApplication) =>
  Layer.succeed(CloudflareAccess, make(application));

/**
 * Access signs in every MCP client, by OAuth or a service token, before the
 * request reaches the bridge. Checking its assertion refuses a request that
 * reaches the MCP port without passing Access.
 */
export const RequireAccess = HttpRouter.middleware()(
  Effect.gen(function* () {
    const access = yield* CloudflareAccess;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const assertion = request.headers["cf-access-jwt-assertion"];
        return assertion !== undefined && (yield* access.verify(assertion))
          ? yield* httpEffect
          : HttpServerResponse.text("Unauthorized", { status: 401 });
      });
  }),
).layer;
