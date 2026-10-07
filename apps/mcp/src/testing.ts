import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Tool from "effect/ai/Tool";

import { BridgeError, Environments, type T3Environment } from "./environment.ts";
import { BridgeToolkit, BridgeToolkitHandlersLive } from "./tools.ts";

/** One paired server whose calls a test has not stubbed die loudly. */
export function fakeEnvironment(overrides: Partial<T3Environment> = {}): T3Environment {
  return {
    id: "home",
    name: "Home",
    expiresAt: "2026-10-28T12:00:00.000Z",
    shell: Effect.die("unused shell"),
    thread: () => Effect.die("unused thread"),
    serverConfig: Effect.die("unused serverConfig"),
    dispatch: () => Effect.die("unused dispatch"),
    launchThread: () => Effect.die("unused launchThread"),
    waitForThread: () => Effect.die("unused waitForThread"),
    createRef: () => Effect.die("unused createRef"),
    switchRef: () => Effect.die("unused switchRef"),
    listRefs: () => Effect.die("unused listRefs"),
    createProject: () => Effect.die("unused createProject"),
    cloneProject: () => Effect.die("unused cloneProject"),
    usageSummary: () => Effect.die("unused usageSummary"),
    ...overrides,
  };
}

/**
 * A server holding one thread. Each read returns the current projection;
 * `react` plays the server's part for a dispatched command by returning the
 * projections later reads see (the last one repeats).
 */
export function threadServer(
  initial: OrchestrationV2ThreadProjection | ReadonlyArray<OrchestrationV2ThreadProjection>,
  react: (
    command: OrchestrationV2Command,
    current: OrchestrationV2ThreadProjection,
  ) => ReadonlyArray<OrchestrationV2ThreadProjection> | void = () => undefined,
  overrides: Partial<T3Environment> = {},
) {
  let reads = Array.isArray(initial) ? [...initial] : [initial as OrchestrationV2ThreadProjection];
  const sent: Array<OrchestrationV2Command> = [];
  const current = () => (reads.length > 1 ? reads.shift()! : reads[0]!);
  const environment = fakeEnvironment({
    thread: (id) =>
      id === reads[0]!.thread.id
        ? Effect.sync(current)
        : Effect.fail(new BridgeError({ message: `Session ${id} was not found.` })),
    dispatch: (command) =>
      Effect.sync(() => {
        sent.push(command);
        const next = react(command, reads[0]!);
        if (next !== undefined) reads = [...next];
        return { sequence: sent.length };
      }),
    ...overrides,
  });
  return { environment, sent, layer: bridgeLayer(environment) };
}

export function bridgeLayer(environment: T3Environment) {
  return BridgeToolkitHandlersLive.pipe(
    Layer.provide(
      Layer.succeed(
        Environments,
        Environments.of({
          enabled: Effect.succeed([environment]),
          get: (id) =>
            id === environment.id
              ? Effect.succeed(environment)
              : Effect.fail(new BridgeError({ message: `Unknown server_id "${id}".` })),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
}

/** Calls one tool the way an MCP client does; a tool failure fails the effect. */
export const callTool = Effect.fnUntraced(function* <Name extends keyof typeof BridgeToolkit.tools>(
  name: Name,
  input: Tool.ParametersEncoded<(typeof BridgeToolkit.tools)[Name]>,
) {
  const toolkit = yield* BridgeToolkit;
  const results = yield* toolkit.handle(name, input).pipe(Effect.flatMap(Stream.runCollect));
  return results[0]!.result as Tool.Success<(typeof BridgeToolkit.tools)[Name]>;
});

/** Test fixtures: a thread one run into fixing a flaky test, running on Codex. */
export const at = (second: number) => `2026-09-28T12:00:${String(second).padStart(2, "0")}.000Z`;
const utc = (second: number) => DateTime.makeUnsafe(at(second));
export const NOW = at(30);
export const threadId = ThreadId.make("thread-1");
export const runId = RunId.make("run-1");
const rootNodeId = NodeId.make("node-root-1");

export function appThread(
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Fix the flaky test",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: utc(1),
    updatedAt: utc(10),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function run(overrides: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run {
  return {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
    providerThreadId: null,
    userMessageId: MessageId.make("user-1"),
    rootNodeId,
    activeAttemptId: null,
    status: "running",
    requestedAt: utc(1),
    startedAt: utc(2),
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

export function message(
  id: string,
  text: string,
  second: number,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage {
  return {
    createdBy: "user",
    creationSource: "web",
    id: MessageId.make(id),
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: utc(second),
    updatedAt: utc(second),
    ...overrides,
  };
}

type ItemOf<Type extends OrchestrationV2TurnItem["type"]> = Extract<
  OrchestrationV2TurnItem,
  { type: Type }
>;

function base(id: string, second: number, ordinal = second) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: rootNodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: utc(second),
    completedAt: utc(second),
    updatedAt: utc(second),
  };
}

export const userMessage = (id: string, text: string, second: number): ItemOf<"user_message"> => ({
  ...base(id, second),
  createdBy: "user",
  creationSource: "web",
  type: "user_message",
  messageId: MessageId.make(id),
  inputIntent: "turn_start",
  text,
  attachments: [],
});

export const assistantMessage = (
  id: string,
  text: string,
  second: number,
  overrides: Partial<ItemOf<"assistant_message">> = {},
): ItemOf<"assistant_message"> => ({
  ...base(id, second),
  type: "assistant_message",
  messageId: MessageId.make(id),
  text,
  streaming: false,
  ...overrides,
});

export const command = (
  id: string,
  input: string,
  second: number,
  overrides: Partial<ItemOf<"command_execution">> = {},
): ItemOf<"command_execution"> => ({
  ...base(id, second),
  type: "command_execution",
  input,
  ...overrides,
});

export const approvalItem = (
  requestId: string,
  second: number,
  overrides: Partial<ItemOf<"approval_request">> = {},
): ItemOf<"approval_request"> => ({
  ...base(`approval-${requestId}`, second),
  status: "waiting",
  completedAt: null,
  type: "approval_request",
  requestId: RuntimeRequestId.make(requestId),
  requestKind: "command",
  ...overrides,
});

export const questionItem = (
  requestId: string,
  second: number,
  questions: ItemOf<"user_input_request">["questions"],
  overrides: Partial<ItemOf<"user_input_request">> = {},
): ItemOf<"user_input_request"> => ({
  ...base(`question-${requestId}`, second),
  status: "waiting",
  completedAt: null,
  type: "user_input_request",
  requestId: RuntimeRequestId.make(requestId),
  questions,
  ...overrides,
});

export const runtimeRequest = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"],
  overrides: Partial<OrchestrationV2RuntimeRequest> = {},
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: rootNodeId,
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: utc(3),
  resolvedAt: null,
  ...overrides,
});

export const checkpoint = (
  files: OrchestrationV2Checkpoint["files"],
  overrides: Partial<OrchestrationV2Checkpoint> = {},
): OrchestrationV2Checkpoint => ({
  id: CheckpointId.make("checkpoint-1"),
  threadId,
  scopeId: CheckpointScopeId.make("scope-1"),
  runId,
  nodeId: rootNodeId,
  parentCheckpointId: null,
  ordinalWithinScope: 1,
  appRunOrdinal: 1,
  ref: CheckpointRef.make("refs/t3/checkpoint-1"),
  status: "ready",
  files,
  capturedAt: utc(20),
  ...overrides,
});

/** The projection a server returns, with `items` as the local timeline in order. */
export function projection(
  overrides: Partial<OrchestrationV2ThreadProjection> & {
    readonly items?: ReadonlyArray<OrchestrationV2TurnItem>;
  } = {},
): OrchestrationV2ThreadProjection {
  const { items = [userMessage("user-1", "Fix the flaky test", 1)], ...rest } = overrides;
  return {
    thread: appThread(),
    runs: [run()],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [message("user-1", "Fix the flaky test", 1)],
    plans: [],
    turnItems: [...items],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    })),
    updatedAt: utc(10),
    ...rest,
  };
}

/** The same thread after its run completed with a reply. */
export const completed = projection({
  runs: [run({ status: "completed", completedAt: utc(20) })],
  items: [
    userMessage("user-1", "Fix the flaky test", 1),
    assistantMessage("reply", "Fixed the retry loop", 20),
  ],
});
