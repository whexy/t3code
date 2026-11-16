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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SuperThreadMemberWatch from "./superThreadMemberWatch.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const here = EnvironmentId.make("environment:here");
const box = EnvironmentId.make("environment:box");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process in these tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** What the linked environment answers when the watch waits on a member's run there. */
const remoteRun = Deferred.makeUnsafe<"completed" | "failed">();

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "super-thread-member-watch" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerWatch = SuperThreadMemberWatch.layer.pipe(
  Layer.provideMerge(layerTest),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(here) }),
  ),
  Layer.provide(
    Layer.mock(PeerForwarding.PeerForwarding)({
      waitForThread: (_scope, _environmentId, input) =>
        Deferred.await(remoteRun).pipe(
          Effect.map((status) => ({
            threadId: input.threadId,
            runId: input.runId ?? null,
            status,
            timedOut: false,
          })),
        ),
    }),
  ),
);

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const watch = yield* SuperThreadMemberWatch.SuperThreadMemberWatch;
  const eventSink = yield* EventSink.EventSinkV2;
  const create = (threadId: ThreadId, superThread = false) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:super"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ...(superThread ? { superThread: true } : {}),
    });
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
  /** Runs every event a command committed through the watch, as its event stream would. */
  const observe = (result: Effect.Success<ReturnType<typeof orchestrator.dispatch>>) =>
    Effect.forEach(result.storedEvents, ({ event }) => watch.handle(event), { discard: true });
  const record = (superThreadId: ThreadId, environmentId: EnvironmentId, threadId: ThreadId) =>
    orchestrator
      .dispatch({
        type: "super_thread.member.record",
        commandId: CommandId.make(`record:${threadId}`),
        threadId: superThreadId,
        member: { environmentId, threadId },
      })
      .pipe(Effect.flatMap(observe));
  /** Commits a run update and hands it to the watch. */
  const finish = Effect.fn("test.finish")(function* (
    run: OrchestrationV2Run,
    status: "completed" | "failed",
  ) {
    const event = {
      id: EventId.make(`event:${run.id}:${status}`),
      type: "run.updated",
      threadId: run.threadId,
      runId: run.id,
      occurredAt: yield* DateTime.now,
      payload: { ...run, status },
    } satisfies OrchestrationV2DomainEvent;
    yield* eventSink.write({ events: [event] });
    yield* watch.handle(event);
    return event;
  });
  const ask = Effect.fn("test.ask")(function* (
    run: OrchestrationV2Run,
    kind: "user_input" | "dynamic_tool_call",
  ) {
    const now = yield* DateTime.now;
    const event = {
      id: EventId.make(`event:${run.id}:${kind}`),
      type: "runtime-request.updated",
      threadId: run.threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make(`request:${run.id}:${kind}`),
        nodeId: run.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    } satisfies OrchestrationV2DomainEvent;
    yield* eventSink.write({ events: [event] });
    yield* watch.handle(event);
  });
  const runOf = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.map(({ runs }) => runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]!));
  const wakesOf = (threadId: ThreadId) =>
    projections.getThreadProjection(threadId).pipe(
      Effect.map(({ messages, runs }) =>
        messages
          .filter((message) => message.id.startsWith("message:super-thread-wake:"))
          .map((message) => ({
            message,
            run: runs.find((run) => run.userMessageId === message.id)!,
          })),
      ),
    );
  return { orchestrator, projections, watch, create, send, record, finish, ask, runOf, wakesOf };
});

it.effect(
  "a member's outcome wakes its super thread once, and outcomes behind a busy one join one wake",
  () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const superThreadId = ThreadId.make("thread:super");
      const lead = ThreadId.make("thread:lead");
      const second = ThreadId.make("thread:second");
      const outsider = ThreadId.make("thread:not-a-member");
      yield* t.create(superThreadId, true);
      yield* t.send(superThreadId, "super:goal");
      const ownRun = yield* t.runOf(superThreadId);
      for (const threadId of [lead, second, outsider]) {
        yield* t.create(threadId);
        yield* t.send(threadId, `${threadId}:task`);
      }
      yield* t.record(superThreadId, here, lead);
      yield* t.record(superThreadId, here, second);

      // Busy with its own run, it queues the wake; the same outcome again adds nothing.
      const completed = yield* t.finish(yield* t.runOf(lead), "completed");
      yield* t.watch.handle(completed);
      // Neither a thread it did not launch nor a tool call T3 answers itself wakes it.
      yield* t.finish(yield* t.runOf(outsider), "completed");
      const secondRun = yield* t.runOf(second);
      yield* t.ask(secondRun, "dynamic_tool_call");
      // Later outcomes join the wake that is still queued.
      yield* t.ask(secondRun, "user_input");
      yield* t.finish(secondRun, "failed");
      const [wake, ...others] = yield* t.wakesOf(superThreadId);
      assert.deepEqual(others, []);
      assert.equal(wake!.run.status, "queued");
      assert.deepEqual(
        wake!.message.text.split("\n").filter((line) => line.startsWith("- ")),
        [
          `- "${lead}" (threadId ${lead}, environmentId ${here}) completed its run.`,
          `- "${second}" (threadId ${second}, environmentId ${here}) is waiting for the user to answer an approval or a question.`,
          `- "${second}" (threadId ${second}, environmentId ${here}) failed.`,
        ],
      );
      assert.deepEqual(wake!.message.notification, {
        source: { kind: "system" },
        outcome: "updated",
        summary: "3 launched threads changed state",
      });

      // Its own run ending wakes nothing more.
      yield* t.finish(ownRun, "completed");
      assert.equal((yield* t.wakesOf(superThreadId)).length, 1);
    }).pipe(Effect.provide(layerWatch)),
);

it.effect("a settled super thread is not woken and stays settled", () =>
  Effect.gen(function* () {
    const t = yield* setup;
    const superThreadId = ThreadId.make("thread:settled-super");
    const member = ThreadId.make("thread:settled-member");
    yield* t.create(superThreadId, true);
    yield* t.create(member);
    yield* t.record(superThreadId, here, member);
    yield* t.orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle:super"),
      threadId: superThreadId,
    });
    yield* t.send(member, "settled-member:task");
    yield* t.finish(yield* t.runOf(member), "completed");
    assert.deepEqual(yield* t.wakesOf(superThreadId), []);
    const { thread } = yield* t.projections.getThreadRecords(superThreadId, []);
    assert.equal(thread.settledOverride, "settled");
  }).pipe(Effect.provide(layerWatch)),
);

it.effect(
  "a run the super thread started in a linked environment wakes it when it ends there",
  () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const superThreadId = ThreadId.make("thread:remote-super");
      const remote = ThreadId.make("thread:remote-member");
      const remoteRunId = RunId.make("run:remote-member");
      yield* t.create(superThreadId, true);
      yield* t.record(superThreadId, box, remote);
      const watch = yield* SuperThreadMemberWatch.SuperThreadMemberWatch;
      const { sequence } = yield* t.orchestrator
        .dispatch({
          type: "super_thread.member.follow",
          commandId: CommandId.make("follow:remote"),
          threadId: superThreadId,
          run: { environmentId: box, threadId: remote, runId: remoteRunId },
        })
        .pipe(
          Effect.tap((result) =>
            Effect.forEach(result.storedEvents, ({ event }) => watch.handle(event), {
              discard: true,
            }),
          ),
          Effect.map((result) => ({ sequence: result.storedEvents[0]!.sequence })),
        );
      const followedOf = t.projections
        .getThreadRecords(superThreadId, [])
        .pipe(Effect.map(({ thread }) => thread.superThread?.following ?? []));
      assert.equal((yield* followedOf).length, 1);

      const woken = yield* t.orchestrator
        .streamStoredEventsFrom({
          threadId: superThreadId,
          afterSequence: sequence,
          eventType: "thread.tags-updated",
        })
        .pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "thread.tags-updated" &&
              event.payload.superThread?.following?.length === 0,
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
      yield* Deferred.succeed(remoteRun, "completed");
      assert.isTrue(Option.isSome(yield* Fiber.join(woken)));
      const [wake] = yield* t.wakesOf(superThreadId);
      assert.include(
        wake!.message.text,
        `(threadId ${remote}, environmentId ${box}) completed its run.`,
      );
      // An idle super thread starts its wake at once.
      assert.notEqual(wake!.run.status, "queued");
      assert.deepEqual(wake!.message.notification, {
        source: { kind: "system" },
        outcome: "completed",
        summary: `${remote} completed`,
      });
      assert.deepEqual(yield* followedOf, []);
    }).pipe(Effect.provide(layerWatch), Effect.scoped),
);
