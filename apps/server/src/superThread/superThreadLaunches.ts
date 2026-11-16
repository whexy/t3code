import {
  CommandId,
  type OrchestratorMcpFailure,
  type SuperThreadInternalCommand,
  type SuperThreadLaunchKey,
  type SuperThreadPendingLaunch,
  type ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Context from "effect/Context";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { forkParked } from "../serverActivation.ts";
import { recordFollowedRun, recordLaunchedMember } from "./superThreadMembers.ts";

type Dispatch<E> = (command: SuperThreadInternalCommand) => Effect.Effect<unknown, E>;

/** Ids come from the launch, so the agent's retry with the same key writes nothing new. */
const launchCommandId = (kind: string, superThreadId: ThreadId, launch: SuperThreadLaunchKey) =>
  CommandId.make(
    `super-thread:launch-${kind}:${superThreadId}:${launch.environmentId}:${encodeURIComponent(
      launch.requestNamespace,
    )}:${encodeURIComponent(launch.clientRequestId)}`,
  );

/**
 * A linked environment picks the thread id, so a super thread writes the launch down before it
 * goes, and the member record that answers it ends it. A call that fails leaves it pending, since
 * the thread may exist there anyway: the agent's retry or the next restart's replay settles it.
 */
export const recordPendingLaunch = <E>(
  dispatch: Dispatch<E>,
  superThreadId: ThreadId,
  launch: SuperThreadPendingLaunch,
) =>
  dispatch({
    type: "super_thread.launch.pending",
    commandId: launchCommandId("pending", superThreadId, launch),
    threadId: superThreadId,
    launch,
  });

/** A linked environment that does not answer is retried, backing off to this. */
const REPLAY_MAX_BACKOFF = Duration.minutes(5);
/** How a replay retries an environment that does not answer; tests step it by hand. */
export const ReplayRetrySchedule = Context.Reference<Schedule.Schedule<unknown>>(
  "t3/superThread/superThreadLaunches/ReplayRetrySchedule",
  {
    defaultValue: () =>
      Schedule.exponential(Duration.seconds(2)).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, REPLAY_MAX_BACKOFF)),
        ),
      ),
  },
);

const LaunchTool = ProjectToolkit.tools.t3_thread_launch;

/**
 * Sends each launch a restart left pending again, as the super thread under the request namespace
 * it went out with: the linked environment scopes the key by this environment's peer session,
 * which a restart keeps, so it answers with the thread it already made or makes it now.
 */
export const replayPendingLaunches = Effect.fn("SuperThread.replayPendingLaunches")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  const retry = yield* ReplayRetrySchedule;
  const rows = yield* sql<{ readonly thread_id: ThreadId }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.superThread.pendingLaunches') IS NOT NULL
  `;

  const replayOne = (
    superThread: { readonly id: ThreadId; readonly providerInstanceId: string },
    launch: SuperThreadPendingLaunch,
  ) => {
    const scope: McpInvocationContext.McpThreadInvocationScope = {
      environmentId: hereId,
      requestNamespace: launch.requestNamespace,
      thread: {
        threadId: superThread.id,
        providerSessionId: launch.requestNamespace,
        providerInstanceId:
          superThread.providerInstanceId as McpInvocationContext.McpThreadCaller["providerInstanceId"],
        superThread: true,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    };
    const params = { ...launch.input, environmentId: launch.environmentId } as never;
    return forwarding.call(scope, LaunchTool, launch.environmentId, params).pipe(
      // Only an unreachable link answers orchestration_error; any other answer is final.
      Effect.retry({
        schedule: retry,
        while: (error: OrchestratorMcpFailure) => error.code === "orchestration_error",
      }),
      Effect.matchEffect({
        onSuccess: (launched) =>
          recordLaunchedMember(
            threads,
            { id: superThread.id, superThread: true },
            { environmentId: launch.environmentId, threadId: launched.threadId },
            launch,
          ).pipe(
            Effect.andThen(
              launched.runId === null
                ? Effect.void
                : recordFollowedRun(threads, superThread.id, {
                    environmentId: launch.environmentId,
                    threadId: launched.threadId,
                    runId: launched.runId,
                  }),
            ),
          ),
        onFailure: (error) =>
          Effect.logWarning("The linked environment refused a replayed launch.", {
            cause: error,
          }).pipe(
            Effect.andThen(
              threads.dispatch({
                type: "super_thread.launch.end",
                commandId: launchCommandId("end", superThread.id, launch),
                threadId: superThread.id,
                launch,
              }),
            ),
          ),
      }),
      Effect.ignoreCause({ log: true }),
    );
  };

  yield* Effect.forEach(
    rows,
    ({ thread_id }) =>
      threads.getThreadRecords(thread_id, []).pipe(
        Effect.flatMap(({ thread }) =>
          thread.deletedAt !== null
            ? Effect.void
            : Effect.forEach(
                thread.superThread?.pendingLaunches ?? [],
                (launch) => replayOne(thread, launch),
                { concurrency: "unbounded", discard: true },
              ),
        ),
        Effect.ignoreCause({ log: true }),
      ),
    { concurrency: "unbounded", discard: true },
  );
});

export const layerReplay = Layer.effectDiscard(
  forkParked(replayPendingLaunches().pipe(Effect.ignoreCause({ log: true }))),
);
