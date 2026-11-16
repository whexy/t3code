import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type SuperThreadInternalCommand,
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
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { layerNoTaskFolders } from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

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

const layerPlatform = Layer.mergeAll(
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
    runForThread: () => Effect.succeed({ status: "no-script" }),
  }),
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
  Layer.provide(layerNoTaskFolders),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provide(ModelManifest.layerTest),
  Layer.provide(layerPlatform),
);

it.layer(layerTest)("super threads", (it) => {
  it.effect(
    "a super thread is fixed at creation, records each launch once and keeps its board off the shell",
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
        assert.deepEqual(yield* stateOf(superThreadId), { members: [], board: null });
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

        const setBoard = (commandId: string, goal: string) =>
          orchestrator.dispatch({
            type: "super_thread.board.set",
            commandId: CommandId.make(commandId),
            threadId: superThreadId,
            board: {
              goal,
              items: [{ id: "api", title: "Ship the API", status: "doing", members: [remote] }],
            },
          });
        yield* setBoard("board:1", "Ship v2");
        yield* setBoard("board:2", "Ship v2 everywhere");
        const now = yield* DateTime.now;
        assert.deepEqual((yield* stateOf(superThreadId))?.board, {
          goal: "Ship v2 everywhere",
          items: [{ id: "api", title: "Ship the API", status: "doing", members: [remote] }],
          updatedAt: DateTime.formatIso(now),
        });
        assert.instanceOf(
          yield* orchestrator
            .dispatch({
              type: "super_thread.board.set",
              commandId: CommandId.make("board:ordinary"),
              threadId: ordinaryThreadId,
              board: { goal: "Not mine", items: [] },
            })
            .pipe(Effect.flip),
          Orchestrator.OrchestratorDispatchError,
        );

        const shell = yield* shellOf(superThreadId);
        assert.deepEqual(shell.superThread, { members: [local, remote] });
        // Members and the board are not activity, so the thread keeps its place in lists.
        assert.deepEqual(shell.updatedAt, createdShell.updatedAt);
        assert.isUndefined((yield* shellOf(ordinaryThreadId)).superThread);
      }),
  );
});
