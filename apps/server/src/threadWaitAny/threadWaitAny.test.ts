import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type {
  ThreadWaitAnyInput,
  ThreadWaitAnyResult,
} from "../mcp/toolkits/threadWaitAny/tools.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { cursorKey, waitForAnyThread } from "./threadWaitAny.ts";

const instanceId = ProviderInstanceId.make("codex");
const here = EnvironmentId.make("environment:here");
const box = EnvironmentId.make("environment:box");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process in these tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-wait-any" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerThreads = Layer.unwrap(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: orchestrator.getThreadShell,
      getThreadRecords: orchestrator.getThreadRecords,
      getThreadEventSequence: orchestrator.getThreadEventSequence,
      streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
    });
  }),
);
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: here,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "thread-wait-any",
  thread: undefined,
  client: undefined,
};

type Forwarded = { readonly environmentId: EnvironmentId; readonly params: unknown };

/** A linked environment that answers each forwarded wait from `answers`, in order. */
const layerTest = (answers: Array<ThreadWaitAnyResult> = [], forwarded: Array<Forwarded> = []) =>
  Layer.mergeAll(
    layerThreads,
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(PeerForwarding.PeerForwarding)({
      call: (_scope, _tool, environmentId, params) =>
        Effect.sync(() => {
          forwarded.push({ environmentId, params });
          return answers.shift() as never;
        }),
    }),
  ).pipe(Layer.provideMerge(layerOrchestration));

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const send = (threadId: ThreadId, key: string) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${key}`),
      threadId,
      messageId: MessageId.make(`message:${key}`),
      text: key,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  /** A thread with a run in flight. */
  const start = Effect.fn("test.start")(function* (name: string) {
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}`),
      threadId,
      projectId: ProjectId.make("project:select"),
      title: name,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(threadId, name);
    return threadId;
  });
  const runOf = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.map(({ runs }) => runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]!));
  const update = Effect.fn("test.update")(function* (
    threadId: ThreadId,
    status: OrchestrationV2Run["status"],
  ) {
    const run = yield* runOf(threadId);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:${run.id}:${status}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: yield* DateTime.now,
          payload: { ...run, status },
        } satisfies OrchestrationV2DomainEvent,
      ],
    });
    return run.id;
  });
  const ask = Effect.fn("test.ask")(function* (threadId: ThreadId) {
    const run = yield* update(threadId, "running");
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:${run}:ask`),
          type: "runtime-request.updated",
          threadId,
          runId: run,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`request:${run}`),
            nodeId: runs.find((candidate) => candidate.id === run)!.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        } satisfies OrchestrationV2DomainEvent,
      ],
    });
  });
  const select = (
    threads: ReadonlyArray<ThreadId>,
    options: Omit<ThreadWaitAnyInput, "threads"> = {},
  ) => waitForAnyThread({ threads: threads.map((threadId) => ({ threadId })), ...options });
  return { send, start, update, ask, select };
});

const statuses = (result: ThreadWaitAnyResult) =>
  result.ready.map(({ threadId, status }) => [threadId, status]);

it.effect("wakes on the first thread with an outcome and delivers each outcome once", () =>
  Effect.gen(function* () {
    const t = yield* setup;
    const [a, b, c] = [yield* t.start("a"), yield* t.start("b"), yield* t.start("c")];

    const first = yield* t.select([a, b, c]).pipe(Effect.forkChild);
    yield* t.update(b, "completed");
    const woke = yield* Fiber.join(first);
    assert.deepEqual(statuses(woke), [[b, "completed"]]);
    assert.isFalse(woke.timedOut);

    // B's outcome is in the cursor, so the next call waits for another one.
    const second = yield* t.select([a, b, c], { cursor: woke.cursor }).pipe(Effect.forkChild);
    yield* t.update(a, "failed");
    const next = yield* Fiber.join(second);
    assert.deepEqual(statuses(next), [[a, "failed"]]);

    // A follow-up run on B is a new outcome once it ends, and not before.
    yield* t.send(b, "b:follow-up");
    const third = yield* t.select([a, b, c], { cursor: next.cursor }).pipe(Effect.forkChild);
    yield* t.update(b, "completed");
    assert.deepEqual(statuses(yield* Fiber.join(third)), [[b, "completed"]]);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("returns every thread already ready in one result, in the order asked", () =>
  Effect.gen(function* () {
    const t = yield* setup;
    const [a, b, c] = [yield* t.start("a"), yield* t.start("b"), yield* t.start("c")];
    yield* t.update(c, "completed");
    yield* t.update(a, "cancelled");

    const result = yield* t.select([a, b, c]);
    assert.deepEqual(statuses(result), [
      [a, "cancelled"],
      [c, "completed"],
    ]);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("wakes when a thread starts waiting for the person, then again when it ends", () =>
  Effect.gen(function* () {
    const t = yield* setup;
    const [a, b] = [yield* t.start("a"), yield* t.start("b")];
    yield* t.ask(a);

    const asking = yield* t.select([a, b]);
    assert.deepEqual(
      asking.ready.map(({ threadId, status, request }) => [threadId, status, request]),
      [[a, "waiting", "user_input"]],
    );

    const done = yield* t.select([a, b], { cursor: asking.cursor }).pipe(Effect.forkChild);
    yield* t.update(b, "completed");
    assert.deepEqual(statuses(yield* Fiber.join(done)), [[b, "completed"]]);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("times out without delivering an outcome the cursor has seen", () =>
  Effect.gen(function* () {
    const t = yield* setup;
    const [a, b] = [yield* t.start("a"), yield* t.start("b")];
    yield* t.update(a, "completed");
    const seen = yield* t.select([a, b]);

    const waiting = yield* t
      .select([a, b], { cursor: seen.cursor, timeoutMs: 60_000 })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(60_000));
    const result = yield* Fiber.join(waiting);
    assert.deepEqual(result, { ready: [], cursor: seen.cursor, timedOut: true });
  }).pipe(Effect.provide(layerTest())),
);

it.effect("rejects an unknown thread and a cursor it did not return", () =>
  Effect.gen(function* () {
    const t = yield* setup;
    const a = yield* t.start("a");
    const missing = yield* t.select([a, ThreadId.make("thread:missing")]).pipe(Effect.flip);
    assert.equal(missing.code, "thread_not_found");
    const forged = yield* t.select([a], { cursor: "not a cursor" }).pipe(Effect.flip);
    assert.equal(forged.code, "invalid_request");
  }).pipe(Effect.provide(layerTest())),
);

const remoteThread = ThreadId.make("thread:on-box");
const remoteRun = RunId.make("run:on-box");
const forwarded: Array<Forwarded> = [];

it.effect("forwards a linked thread's wait there and merges its outcome and cursor", () =>
  Effect.gen(function* () {
    const t = yield* setup;
    const a = yield* t.start("a");
    const result = yield* waitForAnyThread({
      threads: [{ threadId: a }, { threadId: remoteThread, environmentId: box }],
    });
    assert.deepEqual(result.ready, [
      { threadId: remoteThread, environmentId: box, runId: remoteRun, status: "completed" },
    ]);
    assert.equal(result.cursor, `${cursorKey(remoteThread)}:out1`);
    // Each call goes there as a local wait, carrying only that environment's cursor entries.
    assert.deepEqual(
      forwarded.map(({ environmentId, params }) => [environmentId, params]),
      [
        [
          box,
          {
            threads: [{ threadId: remoteThread }],
            cursor: "",
            timeoutMs: 30_000,
          },
        ],
        [
          box,
          {
            threads: [{ threadId: remoteThread }],
            cursor: "",
            timeoutMs: 30_000,
          },
        ],
      ],
    );
  }).pipe(
    Effect.provide(
      layerTest(
        [
          { ready: [], cursor: "", timedOut: true },
          {
            ready: [{ threadId: remoteThread, runId: remoteRun, status: "completed" }],
            cursor: `${cursorKey(remoteThread)}:out1`,
            timedOut: false,
          },
        ],
        forwarded,
      ),
    ),
  ),
);
