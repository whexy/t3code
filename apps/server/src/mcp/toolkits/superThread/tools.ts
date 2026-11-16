import { OrchestratorMcpFailure, SuperThreadMap, SuperThreadMapUpdate } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  SUPER_THREAD_MAP_READ_TOOL_NAME,
  SUPER_THREAD_MAP_UPDATE_TOOL_NAME,
} from "../../../superThread/superThreadRole.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** `McpSchema.EnabledWhen` reads only the client profile, so the caller comes from the request fiber. */
const onlySuperThreads = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.thread?.superThread === true;
};

const SuperThreadMapUpdateTool = Tool.make(SUPER_THREAD_MAP_UPDATE_TOOL_NAME, {
  description:
    "Change this super thread's task map, the graph the user reads to follow your plan. Send only what changed: upsertNodes replaces nodes by id, removeNodes deletes them with their edges, upsertEdges and removeEdges do the same for edges, and reset starts an empty map for a new task. Nodes are your subtasks: a short title, detail with the purpose, boundaries and what counts as done, an optional note such as why it is blocked, an optional group, your status, and threads, the members ({environmentId, threadId}) you launched for it. A linked thread's own state (working, waiting for the user, failed) shows over your status, so set status for what threads can't show: planned, blocked, done or dropped. A depends edge means `to` waits for `from` and sets the left-to-right order; a relates edge only links. Give every change a one-line reason; the user sees it as what changed.",
  parameters: SuperThreadMapUpdate,
  success: Schema.Struct({
    revision: Schema.Int,
    nodeCount: Schema.Int,
    edgeCount: Schema.Int,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
})
  .annotate(Tool.Title, "Update the task map")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, onlySuperThreads);

const SuperThreadMapReadTool = Tool.make(SUPER_THREAD_MAP_READ_TOOL_NAME, {
  description:
    "Read this super thread's task map as the user sees it: the goal, nodes, edges and recent changes. Use it after your context was compacted, and before you answer about the map or a screenshot of it.",
  success: Schema.Struct({ map: Schema.NullOr(SuperThreadMap) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Read the task map")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, onlySuperThreads);

export const SuperThreadToolkit = Toolkit.make(SuperThreadMapUpdateTool, SuperThreadMapReadTool);
