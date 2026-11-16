import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type SuperThreadInternalCommand,
  type SuperThreadMap,
  type SuperThreadMapNode,
  type SuperThreadMapUpdate,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { applySuperThreadMapUpdate } from "./superThreadState.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("no session starts in these tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerPlatform = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("no source control in these tests"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-super-thread-" });

const layerTest = Layer.mergeAll(RuntimeLayer.layer, ProjectionStore.layer).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerServerConfig),
      Layer.provide(layerPlatform),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(Layer.mock(GitWorkflow.GitWorkflowService)({})),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provide(layerPlatform),
);

it.layer(layerTest)("super threads", (it) => {
  it.effect(
    "a super thread is fixed at creation, records each launch once and keeps its map off the shell",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const create = (threadId: ThreadId, superThread: boolean) =>
          orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId: ProjectId.make("project:super"),
            title: threadId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            ...(superThread ? { superThread: true } : {}),
          });
        const superThreadId = ThreadId.make("thread:super");
        const ordinaryThreadId = ThreadId.make("thread:ordinary");
        yield* create(superThreadId, true);
        yield* create(ordinaryThreadId, false);
        const stateOf = (threadId: ThreadId) =>
          orchestrator.getThreadProjection(threadId).pipe(Effect.map((p) => p.thread.superThread));
        assert.deepEqual(yield* stateOf(superThreadId), { members: [] });
        assert.isUndefined(yield* stateOf(ordinaryThreadId));

        const shellOf = (threadId: ThreadId) =>
          orchestrator
            .getShellSnapshot()
            .pipe(Effect.map((shell) => shell.threads.find((thread) => thread.id === threadId)!));
        const createdShell = yield* shellOf(superThreadId);
        yield* TestClock.adjust("1 minute");

        const remote = {
          environmentId: EnvironmentId.make("environment:box"),
          threadId: ThreadId.make("thread:remote"),
        };
        const local = {
          environmentId: EnvironmentId.make("environment:here"),
          threadId: ThreadId.make("thread:local"),
        };
        const record = (commandId: string, threadId: ThreadId, member: typeof local) =>
          orchestrator.dispatch({
            type: "super_thread.member.record",
            commandId: CommandId.make(commandId),
            threadId,
            member,
          } satisfies SuperThreadInternalCommand);
        yield* record("record:local", superThreadId, local);
        // A retried launch replays its record, and a second record of the same pair adds nothing.
        yield* record("record:local", superThreadId, local);
        yield* record("record:local-again", superThreadId, local);
        yield* record("record:remote", superThreadId, remote);
        assert.deepEqual((yield* stateOf(superThreadId))?.members, [local, remote]);

        const refused = yield* record("record:ordinary", ordinaryThreadId, local).pipe(Effect.flip);
        assert.instanceOf(refused, Orchestrator.OrchestratorDispatchError);
        assert.isUndefined(yield* stateOf(ordinaryThreadId));

        const updateMap = (commandId: string, threadId: ThreadId, update: SuperThreadMapUpdate) =>
          orchestrator.dispatch({
            type: "super_thread.map.update",
            commandId: CommandId.make(commandId),
            threadId,
            update,
          });
        yield* updateMap("map:1", superThreadId, {
          reason: "Plan the rollout",
          goal: "Ship v2",
          upsertNodes: [{ id: "api", title: "Ship the API", status: "active", threads: [remote] }],
        });
        const now = yield* DateTime.now;
        assert.deepEqual((yield* stateOf(superThreadId))?.map, {
          goal: "Ship v2",
          nodes: [{ id: "api", title: "Ship the API", status: "active", threads: [remote] }],
          edges: [],
          revision: 1,
          updatedAt: DateTime.formatIso(now),
          changes: [
            {
              revision: 1,
              reason: "Plan the rollout",
              at: DateTime.formatIso(now),
              added: ["api"],
              removed: [],
            },
          ],
        });
        assert.instanceOf(
          yield* updateMap("map:ordinary", ordinaryThreadId, { reason: "Not mine" }).pipe(
            Effect.flip,
          ),
          Orchestrator.OrchestratorDispatchError,
        );

        const shell = yield* shellOf(superThreadId);
        assert.deepEqual(shell.superThread, { members: [local, remote] });
        // Members and the map are not activity, so the thread keeps its place in lists.
        assert.deepEqual(shell.updatedAt, createdShell.updatedAt);
        assert.isUndefined((yield* shellOf(ordinaryThreadId)).superThread);

        // The settle cascade guards a member that has no run yet with `null`.
        const settle = (commandId: string, expectedLatestRunId: RunId | null) =>
          orchestrator.dispatch({
            type: "thread.settle",
            commandId: CommandId.make(commandId),
            threadId: ordinaryThreadId,
            expectedLatestRunId,
          });
        assert.instanceOf(
          yield* settle("settle:stale", RunId.make("run:elsewhere")).pipe(Effect.flip),
          Orchestrator.OrchestratorDispatchError,
        );
        yield* settle("settle:no-run", null);
        assert.equal((yield* shellOf(ordinaryThreadId)).settledOverride, "settled");
      }),
  );
});

describe("task map updates", () => {
  const here = EnvironmentId.make("environment:here");
  const member = { environmentId: here, threadId: ThreadId.make("thread:member") };
  const node = (id: string, extra: Partial<SuperThreadMapNode> = {}): SuperThreadMapNode => ({
    id,
    title: id.toUpperCase(),
    status: "planned",
    ...extra,
  });
  const apply = (current: SuperThreadMap | undefined, update: SuperThreadMapUpdate, at = "t2") => {
    const next = applySuperThreadMapUpdate(current, [member], update, at);
    if ("refused" in next) throw new Error(next.refused);
    return next;
  };
  const first = apply(
    undefined,
    {
      reason: "Plan",
      goal: "Ship",
      upsertNodes: [node("a"), node("b"), node("c")],
      upsertEdges: [
        { from: "a", to: "b", kind: "depends" },
        { from: "b", to: "c", kind: "relates" },
      ],
    },
    "t1",
  );

  it("patches by id, keeps each node's place and removes a node's edges with it", () => {
    const next = apply(first, {
      reason: "Split b",
      upsertNodes: [node("a", { status: "done" }), node("d")],
      removeNodes: ["b", "missing"],
    });
    assert.deepEqual(
      next.nodes.map((n) => [n.id, n.status]),
      [
        ["a", "done"],
        ["c", "planned"],
        ["d", "planned"],
      ],
    );
    assert.deepEqual(next.edges, []);
    assert.equal(next.goal, "Ship");
    assert.equal(next.revision, 2);
    assert.deepEqual(next.changes.at(-1), {
      revision: 2,
      reason: "Split b",
      at: "t2",
      added: ["d"],
      removed: [{ id: "b", title: "B" }],
    });
  });

  it("refuses edges to missing nodes, self edges and threads the super thread did not launch", () => {
    const refusal = (update: SuperThreadMapUpdate) => {
      const next = applySuperThreadMapUpdate(first, [member], update, "t2");
      return "refused" in next ? next.refused : null;
    };
    assert.match(
      refusal({ reason: "x", upsertEdges: [{ from: "a", to: "zz", kind: "depends" }] }) ?? "",
      /not on the map/,
    );
    assert.match(
      refusal({ reason: "x", upsertEdges: [{ from: "a", to: "a", kind: "relates" }] }) ?? "",
      /itself/,
    );
    const stranger = { environmentId: here, threadId: ThreadId.make("thread:stranger") };
    assert.match(
      refusal({ reason: "x", upsertNodes: [node("a", { threads: [stranger] })] }) ?? "",
      /did not launch/,
    );
    assert.isNull(refusal({ reason: "x", upsertNodes: [node("a", { threads: [member] })] }));
  });

  it("starts over on reset without reusing a revision, and keeps the last 20 changes", () => {
    const reset = apply(first, { reason: "New task", reset: true, upsertNodes: [node("x")] });
    assert.deepEqual(
      reset.nodes.map((n) => n.id),
      ["x"],
    );
    assert.equal(reset.goal, "");
    assert.equal(reset.revision, 2);
    assert.deepEqual(
      reset.changes.map((change) => change.revision),
      [2],
    );
    let map = reset;
    for (let i = 0; i < 25; i++) map = apply(map, { reason: `step ${i}` });
    assert.equal(map.changes.length, 20);
    assert.equal(map.changes[0]?.revision, 8);
  });
});
