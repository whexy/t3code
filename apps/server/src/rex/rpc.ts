import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { REX_WS_METHODS } from "@t3tools/contracts/rex";

import type * as RexSessions from "./RexSessions.ts";

// Opening a session starts a shell on this host, as opening an editor does.
export const REX_RPC_SCOPES = {
  [REX_WS_METHODS.rexStatus]: AuthOrchestrationReadScope,
  [REX_WS_METHODS.rexOpen]: AuthOrchestrationOperateScope,
  [REX_WS_METHODS.rexReport]: AuthOrchestrationOperateScope,
} as const;

export const REX_RPC_SPAN_GROUPS = {
  [REX_WS_METHODS.rexStatus]: "workspace",
  [REX_WS_METHODS.rexOpen]: "workspace",
  [REX_WS_METHODS.rexReport]: "workspace",
} as const;

export const rexRpcHandlers = (rex: RexSessions.RexSessionsShape) => ({
  [REX_WS_METHODS.rexStatus]: () => rex.status(),
  [REX_WS_METHODS.rexOpen]: (input: { readonly cwd: string }) => rex.open(input.cwd),
  [REX_WS_METHODS.rexReport]: rex.report,
});
