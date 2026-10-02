import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthClientPresentationMetadata,
} from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import { orchestrationProtocolCompatibilityError } from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { Pairing, ServerRecord } from "./registry.ts";

const CHECK_TIMEOUT_MS = 5_000;

/** How the bridge appears in each server's Connections settings. */
export const CLIENT_METADATA: AuthClientPresentationMetadata = {
  surface: "cli",
  label: "T3 MCP bridge",
};

export class PairingError extends Schema.TaggedError<PairingError>()("PairingError", {
  message: Schema.String,
}) {}

const describe = (host: string, error: RemoteEnvironmentRequestError) => {
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return "The server rejected the pairing link. Links work once and expire after a few minutes; create a new one.";
    case "RemoteEnvironmentAuthFetchError":
    case "RemoteEnvironmentAuthTimeoutError":
      return `The bridge cannot reach ${host}.`;
    default:
      return error.message;
  }
};

/**
 * Pairs like any remote client, but asks only for the scopes the bridge uses:
 * reading orchestration state and starting turns. No terminal or access control.
 */
export const pair = Effect.fn("pair")(function* (link: string) {
  const target = yield* Effect.try({
    try: () => resolveRemotePairingTarget({ pairingUrl: link }),
    catch: (cause) =>
      new PairingError({
        message: cause instanceof Error ? cause.message : "The pairing link is invalid.",
      }),
  });
  const host = new URL(target.httpBaseUrl).host;
  const fail = (error: RemoteEnvironmentRequestError) =>
    Effect.fail(new PairingError({ message: describe(host, error) }));
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.catch(fail));
  const incompatible = orchestrationProtocolCompatibilityError(descriptor);
  if (incompatible !== null) {
    return yield* new PairingError({ message: incompatible.detail });
  }
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    clientMetadata: CLIENT_METADATA,
  }).pipe(Effect.catch(fail));
  const now = yield* DateTime.now;
  return {
    environmentId: descriptor.environmentId,
    name: descriptor.label,
    url: target.httpBaseUrl,
    token: access.access_token,
    pairedAt: DateTime.formatIso(now),
    expiresAt: DateTime.formatIso(DateTime.add(now, { seconds: access.expires_in })),
  } satisfies Pairing;
});

export type ServerHealth =
  | { readonly status: "connected"; readonly expiresAt: string | null }
  | { readonly status: "rejected" }
  | { readonly status: "unreachable"; readonly detail: string };

/** Asks the server whether the bridge's token still works and when it expires. */
export const check = (server: ServerRecord) =>
  fetchRemoteSessionState({
    httpBaseUrl: server.url,
    bearerToken: server.token,
    timeoutMs: CHECK_TIMEOUT_MS,
  }).pipe(
    Effect.map((session): ServerHealth =>
      session.authenticated
        ? {
            status: "connected",
            expiresAt:
              session.expiresAt === undefined ? null : DateTime.formatIso(session.expiresAt),
          }
        : { status: "rejected" },
    ),
    Effect.catch((error) =>
      Effect.succeed<ServerHealth>(
        error._tag === "EnvironmentAuthInvalidError"
          ? { status: "rejected" }
          : { status: "unreachable", detail: error.message },
      ),
    ),
  );
