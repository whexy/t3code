import { OrchestratorMcpFailure, SuperThreadBoardInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { SUPER_THREAD_BOARD_TOOL_NAME } from "../../../superThread/superThreadRole.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** `McpSchema.EnabledWhen` reads only the client profile, so the caller comes from the request fiber. */
const onlySuperThreads = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.thread?.superThread === true;
};

const SuperThreadBoardSetTool = Tool.make(SUPER_THREAD_BOARD_TOOL_NAME, {
  description:
    "Replace this super thread's goal board, which the user reads instead of your transcript. Send the whole board every time: the goal, and each item with a stable id, a title, its status, an optional note, and the members ({environmentId, threadId}) working on it. Update it when work starts, finishes, or gets blocked.",
  parameters: SuperThreadBoardInput,
  success: Schema.Struct({ updatedAt: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
})
  .annotate(Tool.Title, "Update the goal board")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, onlySuperThreads);

export const SuperThreadToolkit = Toolkit.make(SuperThreadBoardSetTool);
