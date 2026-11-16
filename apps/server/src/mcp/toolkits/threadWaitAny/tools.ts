import {
  EnvironmentId,
  OrchestrationV2PendingRuntimeRequestSummary,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadStatus,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const ThreadWaitAnyTarget = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.optional(EnvironmentId),
});
export type ThreadWaitAnyTarget = typeof ThreadWaitAnyTarget.Type;

export const ThreadWaitAnyInput = Schema.Struct({
  threads: Schema.Array(ThreadWaitAnyTarget)
    .check(Schema.isMinLength(1), Schema.isMaxLength(20))
    .annotate({ description: "`environmentId` for a thread on a linked environment." }),
  cursor: Schema.optional(
    Schema.String.check(Schema.isMaxLength(2_000)).annotate({
      description: "The last result's `cursor`. Leave out on the first call.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Finite),
});
export type ThreadWaitAnyInput = typeof ThreadWaitAnyInput.Type;

export const ThreadWaitAnyOutcome = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.optional(EnvironmentId),
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpThreadStatus,
  /** What the thread asks the person, when `status` is `waiting`. */
  request: Schema.optional(OrchestrationV2PendingRuntimeRequestSummary.fields.kind),
});
export type ThreadWaitAnyOutcome = typeof ThreadWaitAnyOutcome.Type;

export const ThreadWaitAnyResult = Schema.Struct({
  ready: Schema.Array(ThreadWaitAnyOutcome),
  cursor: Schema.String,
  timedOut: Schema.Boolean,
  next: Schema.optional(Schema.String),
});
export type ThreadWaitAnyResult = typeof ThreadWaitAnyResult.Type;

export const ThreadWaitAnyTool = Tool.make("t3_thread_wait_any", {
  description:
    "Wait on several threads at once. Returns when any finishes, fails, stops, or waits for the person, with every thread ready by then. Pass back `cursor` to get only new outcomes. On timeout, with `next` end your turn; without, call again.",
  parameters: ThreadWaitAnyInput,
  success: ThreadWaitAnyResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PeerForwarding.PeerForwarding,
  ],
})
  .annotate(Tool.Title, "Wait for T3 threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadWaitAnyToolkit = Toolkit.make(ThreadWaitAnyTool);
