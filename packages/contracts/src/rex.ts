import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// The fork's "Open in Rex". The host's T3 server finds or creates the project's Rex session; the
// Mac's desktop app selects it in its own Rex app through the Mac's Rex server.

export const REX_WS_METHODS = {
  rexStatus: "rex.status",
  rexOpen: "rex.open",
  rexReport: "rex.report",
} as const;

export const RexStatus = Schema.Union([
  Schema.Struct({ available: Schema.Literal(true), hostId: Schema.String }),
  Schema.Struct({ available: Schema.Literal(false), reason: Schema.String }),
]);
export type RexStatus = typeof RexStatus.Type;

export const RexOpenInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type RexOpenInput = typeof RexOpenInput.Type;

export const RexOpenResult = Schema.Struct({
  clickId: Schema.String,
  sessionId: Schema.String,
  hostId: Schema.String,
});
export type RexOpenResult = typeof RexOpenResult.Type;

export const RexReportInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  clickId: Schema.String,
  sessionId: Schema.String,
  outcome: Schema.Literals(["confirm", "abandon"]),
});
export type RexReportInput = typeof RexReportInput.Type;

/** A host-side failure; the message is Rex's own. */
export class RexOpenError extends Schema.TaggedError<RexOpenError>()("RexOpenError", {
  message: Schema.String,
}) {}

const WsRexStatusRpc = Rpc.make(REX_WS_METHODS.rexStatus, {
  payload: Schema.Struct({}),
  success: RexStatus,
  error: EnvironmentAuthorizationError,
});

const WsRexOpenRpc = Rpc.make(REX_WS_METHODS.rexOpen, {
  payload: RexOpenInput,
  success: RexOpenResult,
  error: Schema.Union([RexOpenError, EnvironmentAuthorizationError]),
});

const WsRexReportRpc = Rpc.make(REX_WS_METHODS.rexReport, {
  payload: RexReportInput,
  error: EnvironmentAuthorizationError,
});

export const REX_RPCS = [WsRexStatusRpc, WsRexOpenRpc, WsRexReportRpc] as const;

/** What the Mac's select came to. Only "selected" confirms; "timedOut" reports nothing. */
export type RexSelectOutcome = "selected" | "failed" | "timedOut" | "expired";

export interface RexDesktopBridge {
  readonly available: () => Promise<boolean>;
  /** `clickedAt` is the wall-clock time the click went to the server, in epoch milliseconds. */
  readonly select: (input: {
    readonly sessionId: string;
    readonly clickedAt: number;
  }) => Promise<RexSelectOutcome>;
}

// The desktop preload exposes the bridge under this global.
export const REX_DESKTOP_GLOBAL = "t3Rex";

// Rex for Mac keeps its CLI inside the app's server bundle, off PATH outside Rex terminals.
export const rexMacCliPath = (home: string): string =>
  `${home}/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex`;
