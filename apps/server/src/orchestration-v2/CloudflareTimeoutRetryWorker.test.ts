import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  CLOUDFLARE_TIMEOUT_MAX_RETRIES,
  cloudflareTimeoutRetryAttempt,
} from "./CloudflareTimeoutRetryWorker.ts";

const CLOUDFLARE_524 =
  'API Error: 524 {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/","title":"Error 524: A timeout occurred","status":524,"detail":"The origin web server did not return a complete response within the 120-second Proxy Read Timeout window.","error_name":"origin_response_timeout"';
const threadId = ThreadId.make("thread");
const instanceId = ProviderInstanceId.make("claudeAgent");
const at = (minute: number) =>
  DateTime.makeUnsafe(Date.parse("2026-11-17T10:00:00.000Z") + minute * 60_000);

function run(ordinal: number, messageId: string, status: OrchestrationV2Run["status"] = "failed") {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-opus-5-5" },
    providerThreadId: null,
    userMessageId: MessageId.make(messageId),
    rootNodeId: NodeId.make(`root-${ordinal}`),
    activeAttemptId: null,
    status,
    requestedAt: at(ordinal),
    startedAt: at(ordinal),
    completedAt: status === "running" ? null : at(ordinal),
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

function records(runs: ReadonlyArray<OrchestrationV2Run>, message = CLOUDFLARE_524) {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
    },
    runs,
    runtimeRequests: [],
    turnItems: runs.map((failed) => ({
      id: `error:${failed.id}`,
      type: "error",
      status: "failed",
      runId: failed.id,
      nodeId: failed.rootNodeId,
      ordinal: 1,
      updatedAt: failed.completedAt,
      failure: { class: "provider_error", message, code: "api_error_524", retryable: null },
    })),
  } as unknown as Parameters<typeof cloudflareTimeoutRetryAttempt>[0];
}

it("retries only Cloudflare's own 524, a bounded number of times in a row", () => {
  const user = run(1, "message-1");
  assert.strictEqual(cloudflareTimeoutRetryAttempt(records([user]), user.id), 1);
  // An origin's own 524 is not the edge timing out.
  assert.isNull(
    cloudflareTimeoutRetryAttempt(records([user], "API Error: 524 origin timed out"), user.id),
  );

  const retries = Array.from({ length: CLOUDFLARE_TIMEOUT_MAX_RETRIES }, (_, index) =>
    run(index + 2, `cloudflare-timeout-retry:${threadId}:run-${index + 1}`),
  );
  const chain = [user, ...retries];
  assert.strictEqual(
    cloudflareTimeoutRetryAttempt(records(chain.slice(0, -1)), chain.at(-2)!.id),
    CLOUDFLARE_TIMEOUT_MAX_RETRIES,
  );
  assert.isNull(cloudflareTimeoutRetryAttempt(records(chain), chain.at(-1)!.id));
  // A run the user sent after the chain starts the count over.
  const fresh = run(chain.length + 1, "message-2");
  assert.strictEqual(cloudflareTimeoutRetryAttempt(records([...chain, fresh]), fresh.id), 1);
});

it("does not retry once the thread has moved on", () => {
  const failed = run(1, "message-1");
  assert.isNull(
    cloudflareTimeoutRetryAttempt(records([failed, run(2, "message-2", "running")]), failed.id),
  );
  assert.isNull(
    cloudflareTimeoutRetryAttempt(records([failed, run(2, "message-2", "completed")]), failed.id),
  );
  const archived = records([failed]);
  assert.isNull(
    cloudflareTimeoutRetryAttempt(
      { ...archived, thread: { ...archived.thread, archivedAt: at(5) } },
      failed.id,
    ),
  );
});
