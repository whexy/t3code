import {
  type EnvironmentId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { readCaller, threadNotFound, unavailable } from "../mcp/threadAccess.ts";
import {
  type ThreadWaitAnyInput,
  type ThreadWaitAnyOutcome,
  type ThreadWaitAnyResult,
  ThreadWaitAnyTool,
} from "../mcp/toolkits/threadWaitAny/tools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1_000;

type Threads = ThreadManagementService.ThreadManagementService["Service"];

const LIVE_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * What a thread has to report, or nothing while it is still working. A thread
 * holding on work it awaits is still working, as the sidebar and task map show it.
 * `token` names the outcome, so the cursor can tell a new one from one delivered.
 */
function threadOutcome(
  shell: OrchestrationV2ThreadShell,
): (Omit<ThreadWaitAnyOutcome, "environmentId"> & { readonly token: string }) | undefined {
  const request = shell.pendingRuntimeRequest;
  if (request !== null) {
    return {
      threadId: shell.id,
      runId: shell.activeRunId ?? shell.latestRunId,
      status: "waiting",
      request: request.kind,
      token: `ask:${request.id}`,
    };
  }
  if (
    shell.activeRunId !== null ||
    LIVE_STATUSES.has(shell.status) ||
    backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? [])
  ) {
    return undefined;
  }
  return shell.latestRunId === null
    ? { threadId: shell.id, runId: null, status: "idle", token: "idle" }
    : {
        threadId: shell.id,
        runId: shell.latestRunId,
        status: shell.status,
        token: `run:${shell.latestRunId}:${shell.status}`,
      };
}

/** A few base-36 characters per thread, so a model copies the cursor without mistakes. */
const shortHash = (text: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(36);
};

/** Thread ids are unique across environments, so a peer's cursor entries merge as they are. */
export const cursorKey = (threadId: ThreadId) => shortHash(threadId);

const invalidCursor = new OrchestratorMcpFailure({
  code: "invalid_request",
  message:
    "`cursor` is not one this tool returned. Pass the last result's `cursor`, or leave it out.",
});

const parseCursor = (cursor: string | undefined) => {
  const seen = new Map<string, string>();
  if (cursor === undefined || cursor === "") return Effect.succeed(seen);
  for (const entry of cursor.split(",")) {
    const match = /^([0-9a-z]+):([0-9a-z]+)$/.exec(entry);
    if (match === null) return Effect.fail(invalidCursor);
    seen.set(match[1]!, match[2]!);
  }
  return Effect.succeed(seen);
};

const formatCursor = (seen: ReadonlyMap<string, string>, threadIds: ReadonlyArray<ThreadId>) =>
  threadIds
    .flatMap((threadId) => {
      const key = cursorKey(threadId);
      const value = seen.get(key);
      return value === undefined ? [] : [`${key}:${value}`];
    })
    .join(",");

// Secret and link cards wait for the person without a runtime request.
const wakes = ({ event }: OrchestrationV2StoredEvent) =>
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type === "provider-thread.updated" ||
  event.type === "thread.deleted" ||
  (event.type === "turn-item.updated" &&
    (event.payload.type === "secret_request" || event.payload.type === "link_request"));

const readShells = (threads: Threads, threadIds: ReadonlyArray<ThreadId>) =>
  Effect.forEach(
    threadIds,
    (threadId) =>
      threads.getThreadShell(threadId).pipe(
        Effect.mapError(unavailable),
        Effect.filterOrElse(
          (shell): shell is OrchestrationV2ThreadShell =>
            shell !== null && shell.deletedAt === null,
          () => threadNotFound(threads, threadId, `Thread ${threadId} was not found.`),
        ),
      ),
    { concurrency: "unbounded" },
  );

/** The local threads with an outcome the cursor has not seen, and every shell read. */
const evaluateLocal = Effect.fnUntraced(function* (
  threads: Threads,
  threadIds: ReadonlyArray<ThreadId>,
  seen: ReadonlyMap<string, string>,
) {
  const shells = yield* readShells(threads, threadIds);
  const ready = shells.flatMap((shell) => {
    const outcome = threadOutcome(shell);
    return outcome === undefined || seen.get(cursorKey(shell.id)) === shortHash(outcome.token)
      ? []
      : [outcome];
  });
  return { shells, ready };
});

/** Resolves once a local thread has something new; the caller reads it again for what. */
const waitLocal = Effect.fn("ThreadWaitAny.waitLocal")(function* (
  threads: Threads,
  threadIds: ReadonlyArray<ThreadId>,
  seen: ReadonlyMap<string, string>,
) {
  // Taken before the first read, so an update between that read and the subscription still replays.
  const afterSequences = yield* Effect.forEach(
    threadIds,
    (threadId) => threads.getThreadEventSequence(threadId).pipe(Effect.mapError(unavailable)),
    { concurrency: "unbounded" },
  );
  const none = { ready: [], delivered: [] } as const;
  if ((yield* evaluateLocal(threads, threadIds, seen)).ready.length > 0) return none;
  yield* Stream.mergeAll(
    threadIds.map((threadId, index) =>
      threads.streamStoredEventsFrom({ threadId, afterSequence: afterSequences[index]! }),
    ),
    { concurrency: "unbounded" },
  ).pipe(
    Stream.mapError(unavailable),
    Stream.filter(wakes),
    Stream.mapEffect(() => evaluateLocal(threads, threadIds, seen)),
    Stream.filter(({ ready }) => ready.length > 0),
    Stream.runHead,
  );
  return none;
});

/** The same tool on the linked environment, in pieces short enough to survive any route. */
const waitRemote = Effect.fn("ThreadWaitAny.waitRemote")(function* (
  forwarding: PeerForwarding.PeerForwarding["Service"],
  scope: McpInvocationScope,
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
  seen: ReadonlyMap<string, string>,
) {
  while (true) {
    const result = yield* forwarding.call(scope, ThreadWaitAnyTool, environmentId, {
      threads: threadIds.map((threadId) => ({ threadId })),
      cursor: formatCursor(seen, threadIds),
      timeoutMs: PeerForwarding.FORWARDED_WAIT_CHUNK_MS,
    });
    if (result.ready.length === 0) continue;
    return {
      ready: result.ready.map((outcome) => ({ ...outcome, environmentId })),
      delivered: [...(yield* parseCursor(result.cursor))],
    };
  }
});

/** Owned tasks wake their parent when they finish, so a timed-out wait on only them should end the turn. */
const wakesCaller = Effect.fnUntraced(function* (
  threads: Threads,
  callerId: ThreadId,
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
) {
  if (shells.some((shell) => shell.pendingRuntimeRequest !== null)) return false;
  const { subagents } = yield* threads
    .getThreadRecords(callerId, ["subagents"])
    .pipe(Effect.mapError(unavailable));
  return shells.every((shell) =>
    subagents.some(
      (task) =>
        task.origin === "app_owned" &&
        task.threadId === callerId &&
        task.childThreadId === shell.id &&
        task.completionDelivery?.state !== "disposed",
    ),
  );
});

export const waitForAnyThread = Effect.fn("ThreadWaitAny.wait")(function* (
  input: ThreadWaitAnyInput,
) {
  const { scope, threads, caller } = yield* readCaller();
  const seen = yield* parseCursor(input.cursor);
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  const order: Array<ThreadId> = [];
  const local: Array<ThreadId> = [];
  const remote = new Map<EnvironmentId, Array<ThreadId>>();
  for (const { threadId, environmentId } of input.threads) {
    if (order.includes(threadId)) continue;
    order.push(threadId);
    const target = PeerForwarding.remoteTarget(scope, environmentId);
    if (target === undefined) local.push(threadId);
    else remote.set(target, [...(remote.get(target) ?? []), threadId]);
  }
  const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
  if (remote.size > 0) {
    if (scope.linkedEnvironments === false) return yield* PeerForwarding.linkedEnvironmentsOff;
    if (Option.isNone(forwarding)) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "This environment cannot reach linked environments.",
      });
    }
  }
  // Unknown local threads fail now, not at the timeout.
  if (local.length > 0) yield* readShells(threads, local);

  const groups = [
    ...(local.length === 0 ? [] : [waitLocal(threads, local, seen)]),
    ...(Option.isNone(forwarding)
      ? []
      : [...remote].map(([environmentId, threadIds]) =>
          waitRemote(forwarding.value, scope, environmentId, threadIds, seen),
        )),
  ];
  // Any group waking ends the wait; local threads are read again, so every one ready by then
  // comes back. The cursor moves only for outcomes this call returns.
  type Woken = {
    readonly ready: ReadonlyArray<ThreadWaitAnyOutcome>;
    readonly delivered: ReadonlyArray<readonly [string, string]>;
  };
  const attempt: Effect.Effect<Woken, OrchestratorMcpFailure> = Effect.gen(function* () {
    const fromRemote = yield* Effect.raceAllFirst(groups);
    if (local.length === 0) return fromRemote;
    const { ready } = yield* evaluateLocal(threads, local, seen);
    if (ready.length + fromRemote.ready.length === 0) return yield* attempt;
    return {
      ready: [...ready.map(({ token: _token, ...outcome }) => outcome), ...fromRemote.ready],
      delivered: [
        ...ready.map((outcome) => [cursorKey(outcome.threadId), shortHash(outcome.token)] as const),
        ...fromRemote.delivered,
      ],
    };
  });
  const woken = yield* attempt.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
  if (Option.isSome(woken)) {
    for (const [key, value] of woken.value.delivered) seen.set(key, value);
    return {
      ready: woken.value.ready.toSorted(
        (left, right) => order.indexOf(left.threadId) - order.indexOf(right.threadId),
      ),
      cursor: formatCursor(seen, order),
      timedOut: false,
    } satisfies ThreadWaitAnyResult;
  }
  const next =
    caller !== undefined &&
    remote.size === 0 &&
    (yield* wakesCaller(threads, caller.id, yield* readShells(threads, local)));
  return {
    ready: [],
    cursor: formatCursor(seen, order),
    timedOut: true,
    ...(next ? { next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } : {}),
  } satisfies ThreadWaitAnyResult;
});
