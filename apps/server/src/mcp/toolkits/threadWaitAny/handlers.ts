import { waitForAnyThread } from "../../../threadWaitAny/threadWaitAny.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ThreadWaitAnyToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ThreadWaitAnyToolkit, {
  t3_thread_wait_any: McpToolAccess.reads(waitForAnyThread),
});
