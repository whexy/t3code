import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { openSuperThreadPanel } from "../components/superThread/superThreadPanelActions";

// Old super page links open the conversation with the goal and map panel showing.
export const Route = createFileRoute("/_chat/super/$superEnvironmentId/$superThreadId")({
  beforeLoad: ({ params }) => {
    openSuperThreadPanel(
      scopeThreadRef(
        EnvironmentId.make(params.superEnvironmentId),
        ThreadId.make(params.superThreadId),
      ),
    );
    throw redirect({
      to: "/$environmentId/$threadId",
      params: { environmentId: params.superEnvironmentId, threadId: params.superThreadId },
      replace: true,
    });
  },
});
