import { CommandId, MessageId, type RunId, type ThreadId } from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  runRanAfter,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

// Cloudflare's own 524 body, not an origin's 524: the edge gave up waiting, so the request can be sent again.
const CLOUDFLARE_ORIGIN_TIMEOUT =
  'API Error: 524 {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/"';
const RETRY_MESSAGE_PREFIX = "cloudflare-timeout-retry:";
const CLOUDFLARE_TIMEOUT_RETRY_DELAY = Duration.seconds(30);
export const CLOUDFLARE_TIMEOUT_MAX_RETRIES = 3;

type RetryRecords = ProjectionStore.ProjectionRecords<"runs" | "turnItems" | "runtimeRequests">;

/** The retry attempt to send for a run that failed on a Cloudflare origin timeout, or null. */
export function cloudflareTimeoutRetryAttempt(
  records: RetryRecords,
  failedRunId: RunId,
): number | null {
  const { thread, runs } = records;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    records.runtimeRequests.some((request) => request.status === "pending") ||
    // Work the user started or queued since takes precedence over a retry.
    runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    )
  )
    return null;
  const failed = latestExecutedRun(runs);
  if (failed?.id !== failedRunId) return null;
  const failure = latestRootProviderFailure(failed, records.turnItems);
  if (failure?.message.startsWith(CLOUDFLARE_ORIGIN_TIMEOUT) !== true) return null;
  const executed = runs
    .filter(
      (run) => run.status !== "queued" && (run.status !== "cancelled" || run.startedAt !== null),
    )
    .toSorted((a, b) => (runRanAfter(a, b) ? -1 : runRanAfter(b, a) ? 1 : 0));
  let attempt = 1;
  for (const run of executed) {
    if (!run.userMessageId.startsWith(RETRY_MESSAGE_PREFIX)) break;
    attempt += 1;
  }
  return attempt > CLOUDFLARE_TIMEOUT_MAX_RETRIES ? null : attempt;
}

/**
 * Sends "Continue where you left off." a short while after a run fails on Cloudflare's 524, up to
 * a few times in a row. Timers live in memory, so a server restart drops a waiting retry.
 */
const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const retryWhenDue = Effect.fn("CloudflareTimeoutRetryWorker.retryWhenDue")(
    function* (threadId: ThreadId, failedRunId: RunId) {
      yield* Effect.sleep(CLOUDFLARE_TIMEOUT_RETRY_DELAY);
      const records = yield* projections.getThreadRecords(
        threadId,
        ["runs", "turnItems", "runtimeRequests"],
        {
          turnItemRunIds: [failedRunId],
          turnItemTypes: ["error"],
          runtimeRequestStatuses: ["pending"],
        },
      );
      const attempt = cloudflareTimeoutRetryAttempt(records, failedRunId);
      if (attempt === null) return;
      yield* Effect.logInfo("orchestration-v2.cloudflare-timeout-retry", {
        threadId,
        failedRunId,
        attempt,
      });
      const identity = `${RETRY_MESSAGE_PREFIX}${threadId}:${failedRunId}`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        // One retry per failed run, even across duplicate events.
        commandId: CommandId.make(`server:${identity}`),
        messageId: MessageId.make(identity),
        threadId,
        text: "Continue where you left off.",
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("orchestration-v2.cloudflare-timeout-retry-skipped", {
            threadId,
            cause,
          }),
        ),
      ),
  );

  const timers = yield* FiberMap.make<ThreadId>();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      event.type === "run.updated" && event.payload.status === "failed"
        ? FiberMap.run(timers, event.threadId, retryWhenDue(event.threadId, event.payload.id))
        : Effect.void,
    ),
  );
});

export const layer = Layer.effectDiscard(make).pipe(Layer.provide(ProjectionStore.layer));
