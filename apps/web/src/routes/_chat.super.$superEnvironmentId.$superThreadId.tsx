import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { SuperThreadPage } from "../components/superThread/SuperThreadPage";

// Not `environmentId`/`threadId`: the chat layout reads those params as an open chat route.
export const Route = createFileRoute("/_chat/super/$superEnvironmentId/$superThreadId")({
  component: SuperThreadRoute,
});

function SuperThreadRoute() {
  const { superEnvironmentId, superThreadId } = Route.useParams();
  return (
    <SuperThreadPage
      threadRef={scopeThreadRef(
        EnvironmentId.make(superEnvironmentId),
        ThreadId.make(superThreadId),
      )}
    />
  );
}
