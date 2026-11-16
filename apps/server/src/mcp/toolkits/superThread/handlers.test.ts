import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type Project as ProjectRecord,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ProjectHandlers from "../project/handlers.ts";
import { ProjectToolkit } from "../project/tools.ts";
import * as SuperThreadHandlers from "./handlers.ts";
import { SuperThreadToolkit } from "./tools.ts";

const here = EnvironmentId.make("environment:here");
const box = EnvironmentId.make("environment:box");
const projectId = ProjectId.make("project:super");
const codex = ProviderInstanceId.make("codex");
const superThreadId = ThreadId.make("thread:super");
const ordinaryThreadId = ThreadId.make("thread:ordinary");
const remoteThreadId = ThreadId.make("thread:remote-launch");

const callerShell = (threadId: ThreadId): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(threadId),
  projectId,
  ...(threadId === superThreadId ? { superThread: { members: [] } } : {}),
});

const scopeOf = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: here,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: codex,
    superThread: threadId === superThreadId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

type Step =
  | { readonly kind: "dispatch"; readonly command: OrchestrationV2ServerCommand }
  | { readonly kind: "launch"; readonly threadId: ThreadId | undefined }
  | { readonly kind: "forward"; readonly environmentId: EnvironmentId };

const toolHarness = (caller: ThreadId) => {
  const steps: Array<Step> = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, scopeOf(caller)),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(threadId === caller ? callerShell(caller) : null),
      dispatch: (command) =>
        Effect.sync(() => {
          steps.push({ kind: "dispatch", command });
          return { sequence: 1, storedEvents: [] } as never;
        }),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: () => Effect.void,
      launch: (launch) => {
        steps.push({ kind: "launch", threadId: launch.threadId });
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeedSome({ id, workspaceRoot: "/projects/super" } as unknown as ProjectRecord),
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({
      call: (_scope, _tool, environmentId) => {
        steps.push({ kind: "forward", environmentId });
        return Effect.succeed({
          threadId: remoteThreadId,
          projectId,
          modelSelection: { instanceId: codex, model: "gpt-5" },
          runId: null,
          status: null,
        } as never);
      },
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ServerSettings.layerTest(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-super-thread-mcp-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const handlers = Layer.mergeAll(
    McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer),
    McpToolAccess.HandlersLayer.layer(SuperThreadHandlers.layer),
  ).pipe(Layer.provideMerge(dependencies));
  const launch = (params: {
    readonly clientRequestId?: string;
    readonly environmentId?: EnvironmentId;
  }) =>
    Effect.flatMap(ProjectToolkit, (toolkit) =>
      toolkit
        .handle("t3_thread_launch", { title: "Child", projectId, message: "Go", ...params })
        .pipe(Stream.unwrap, Stream.runCollect),
    ).pipe(Effect.provide(handlers));
  const setBoard = Effect.flatMap(SuperThreadToolkit, (toolkit) =>
    toolkit
      .handle("super_thread_board_set", {
        goal: "Ship v2",
        items: [{ id: "api", title: "Ship the API", status: "doing" }],
      })
      .pipe(Stream.unwrap, Stream.runCollect),
  ).pipe(Effect.provide(handlers));
  return { steps, launch, setBoard };
};

const recorded = (threadId: ThreadId, environmentId: EnvironmentId, member: ThreadId) => ({
  kind: "dispatch",
  command: expect.objectContaining({
    type: "super_thread.member.record",
    threadId,
    member: { environmentId, threadId: member },
  }),
});

it.effect("a super thread records a thread it launches here before the launch starts it", () =>
  Effect.gen(function* () {
    const { steps, launch } = toolHarness(superThreadId);
    yield* launch({ clientRequestId: "child-1" });
    yield* launch({ clientRequestId: "child-1" });
    const childId = steps.flatMap((step) => (step.kind === "launch" ? [step.threadId!] : []))[0]!;
    expect(steps).toEqual([
      recorded(superThreadId, here, childId),
      { kind: "launch", threadId: childId },
      recorded(superThreadId, here, childId),
      { kind: "launch", threadId: childId },
    ]);
    // The retry sends the same record, which the orchestrator replays from its receipt.
    const records = steps.flatMap((step) => (step.kind === "dispatch" ? [step.command] : []));
    expect(records[1]).toEqual(records[0]);
  }),
);

it.effect(
  "a super thread records a thread it launches in a linked environment once it returns",
  () =>
    Effect.gen(function* () {
      const { steps, launch } = toolHarness(superThreadId);
      yield* launch({ environmentId: box });
      expect(steps).toEqual([
        { kind: "forward", environmentId: box },
        recorded(superThreadId, box, remoteThreadId),
      ]);
    }),
);

it.effect("an ordinary thread's launches, here or linked, record nothing", () =>
  Effect.gen(function* () {
    const { steps, launch } = toolHarness(ordinaryThreadId);
    yield* launch({});
    yield* launch({ environmentId: box });
    expect(steps.map((step) => step.kind)).toEqual(["launch", "forward"]);
  }),
);

it.effect("only a super thread can set its goal board", () =>
  Effect.gen(function* () {
    const ordinary = toolHarness(ordinaryThreadId);
    expect(JSON.stringify(yield* ordinary.setBoard)).toContain("capability_denied");
    expect(ordinary.steps).toEqual([]);

    const coordinator = toolHarness(superThreadId);
    yield* coordinator.setBoard;
    expect(coordinator.steps).toEqual([
      {
        kind: "dispatch",
        command: expect.objectContaining({
          type: "super_thread.board.set",
          threadId: superThreadId,
          board: {
            goal: "Ship v2",
            items: [{ id: "api", title: "Ship the API", status: "doing" }],
          },
        }),
      },
    ]);
  }),
);

const superProjection = {
  thread: {
    id: superThreadId,
    projectId,
    title: "Coordinator",
    createdBy: "user",
    creationSource: "web",
    modelSelection: { instanceId: codex, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    superThread: { members: [], board: null },
  },
  runs: [
    {
      id: RunId.make("run:super"),
      ordinal: 1,
      status: "running",
      rootNodeId: NodeId.make("node:super-root"),
      providerInstanceId: codex,
      modelSelection: { instanceId: codex, model: "gpt-5.4" },
    },
  ],
  contextTransfers: [],
  subagents: [],
  messages: [],
} as unknown as OrchestrationV2ThreadProjection;

const serviceHarness = () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === superThreadId
                ? superProjection
                : ({
                    thread: {
                      id: threadId,
                      title: "Child",
                      modelSelection: { instanceId: codex, model: "gpt-5.4" },
                    },
                    runs: [],
                  } as unknown as OrchestrationV2ThreadProjection),
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: codex,
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              installed: true,
              version: "test",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-11-15T00:00:00.000Z",
              models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
              slashCommands: [],
              skills: [],
            },
          ]),
        }),
        Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            list: () => Effect.succeed([codex]),
            get: (instanceId) =>
              Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
          }),
        ),
        Layer.mock(Project.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );
  return { dispatched, layer };
};

it.effect("create_threads records each thread before creating it, and delegate_task none", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = serviceHarness();
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const { threads } = yield* service.createThreads(scopeOf(superThreadId), {
        threads: [{ prompt: "First" }, { prompt: "Second" }],
        clientRequestId: "create-two",
      });
      const recordedBeforeCreate = threads.map(({ threadId }) => {
        const record = dispatched.findIndex(
          (command) =>
            command.type === "super_thread.member.record" &&
            command.member.environmentId === here &&
            command.member.threadId === threadId,
        );
        const create = dispatched.findIndex(
          (command) => command.type === "thread.create" && command.threadId === threadId,
        );
        return record !== -1 && record < create;
      });
      expect(recordedBeforeCreate).toEqual([true, true]);

      dispatched.length = 0;
      yield* service
        .delegateTask(scopeOf(superThreadId), {
          task: "Review the diff.",
          mode: "async",
          clientRequestId: "review",
        })
        .pipe(Effect.exit);
      const types = dispatched.map((command) => command.type);
      expect(types).toContain("delegated_task.request");
      expect(types).not.toContain("super_thread.member.record");
    }).pipe(Effect.provide(layer));
  }),
);
