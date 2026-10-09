import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  ORCHESTRATION_PROTOCOL_VERSION,
  sessionGrantsScope,
  type AuthClientPresentationMetadata,
  type AuthGrantScope,
  type ExecutionEnvironmentDescriptor,
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

/**
 * Every permission a tool needs: reading and running threads, usage totals
 * for `get_usage`, and cloning or switching branches for `create_project` and
 * session checkouts. No terminal, file, settings, or access control.
 */
export const BRIDGE_SCOPES: ReadonlyArray<AuthGrantScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthDiagnosticsReadScope,
  AuthSourceControlWriteScope,
];

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
 * Pairs like any remote client, but asks only for `BRIDGE_SCOPES`. The server
 * grants the ones the pairing link allows and ignores ones it does not know.
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
    scopes: BRIDGE_SCOPES,
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

/** Whether a server speaks the orchestration protocol this bridge uses. */
export type ServerSupport =
  | { readonly status: "supported" }
  | { readonly status: "too_old"; readonly serverVersion: string }
  | { readonly status: "unknown" };

/**
 * Reads the protocol from the descriptor every client negotiates with.
 * Servers from before negotiation omit it and speak protocol 1, as in
 * client-runtime's compatibility check.
 */
export function supportOf(descriptor: ExecutionEnvironmentDescriptor): ServerSupport {
  return (descriptor.orchestrationProtocolVersion ?? 1) < ORCHESTRATION_PROTOCOL_VERSION
    ? { status: "too_old", serverVersion: descriptor.serverVersion }
    : { status: "supported" };
}

/**
 * Checked on every use, so an upgraded server comes back on its next call.
 * An unreachable server is "unknown", never too old: its own call reports why.
 */
export const support = (server: ServerRecord) =>
  fetchRemoteEnvironmentDescriptor({ httpBaseUrl: server.url, timeoutMs: CHECK_TIMEOUT_MS }).pipe(
    Effect.map(supportOf),
    Effect.orElseSucceed((): ServerSupport => ({ status: "unknown" })),
  );

export const tooOldMessage = (serverId: string, serverVersion: string) =>
  `Server "${serverId}" is disabled automatically because its T3 Code (${serverVersion}) is too old for this bridge. Update T3 Code on that server; the bridge enables it again on the next call.`;

export type ServerHealth =
  | {
      readonly status: "connected";
      readonly expiresAt: string | null;
      /** Bridge permissions the token lacks; their tools fail until a re-pair grants them. */
      readonly missing: ReadonlyArray<AuthGrantScope>;
    }
  | { readonly status: "too_old"; readonly serverVersion: string }
  | { readonly status: "rejected" }
  | { readonly status: "unreachable"; readonly detail: string };

/** Asks the server whether it is new enough, and whether the bridge's token still works. */
export const check = (server: ServerRecord) =>
  support(server).pipe(
    Effect.flatMap((supported) =>
      supported.status === "too_old" ? Effect.succeed<ServerHealth>(supported) : checkToken(server),
    ),
  );

const checkToken = (server: ServerRecord) =>
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
            missing: BRIDGE_SCOPES.filter((scope) => !sessionGrantsScope(session, scope)),
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
