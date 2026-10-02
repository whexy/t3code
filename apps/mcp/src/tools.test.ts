import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type ClientOrchestrationCommand,
  type OrchestrationThread,
  type VcsListRefsResult,
  ServerConfig,
  OrchestrationShellSnapshot,
  ProviderApprovalDecision,
  ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BridgeError, Environments, type T3Environment } from "./environment.ts";
import { summarizeSession } from "./status.ts";
import { activity, at, message, NOW, thread } from "./testing.ts";
import { BridgeToolkit, BridgeToolkitHandlersLive } from "./tools.ts";

/** A bridge paired with one server that holds `session` and records turn starts. */
const config = Schema.decodeSync(ServerConfig)({
  environment: {
    environmentId: "env-home",
    label: "Home",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: { requiredWorktreeBootstrap: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "t3",
  },
  cwd: "/project",
  keybindingsConfigPath: "/keys.json",
  keybindings: [],
  issues: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: { defaultThreadEnvMode: "worktree" },
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: NOW,
      models: [
        { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null, isDefault: true },
      ],
      slashCommands: [],
      skills: [],
    },
  ],
});
const shell = Schema.decodeSync(OrchestrationShellSnapshot)({
  snapshotSequence: 1,
  updatedAt: NOW,
  projects: [
    {
      id: "project-1",
      title: "Project",
      workspaceRoot: "/project",
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  threads: [],
});

type CreateSessionInput = typeof BridgeToolkit.tools.create_session.parametersSchema.Type;

function bridgeWith(session: OrchestrationThread, overrides: Partial<T3Environment> = {}) {
  const sent: Array<ClientOrchestrationCommand> = [];
  const environment: T3Environment = {
    id: "home",
    name: "Home",
    expiresAt: "2026-10-28T12:00:00.000Z",
    shell: Effect.succeed(shell),
    createProject: () => Effect.die("unused"),
    cloneProject: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    waitForThread: () => Effect.never,
    serverConfig: Effect.succeed(config),
    dispatchCommand: (command) =>
      Effect.sync(() => {
        sent.push(command);
        return { sequence: sent.length };
      }),
    createRef: () => Effect.die("unused"),
    switchRef: () => Effect.die("unused"),
    listRefs: () => Effect.die("unused"),
    usageSummary: () => Effect.die("unused"),
    thread: (threadId) =>
      threadId === session.id
        ? Effect.succeed({ snapshotSequence: 1, thread: session })
        : Effect.fail(new BridgeError({ message: `Session ${threadId} was not found.` })),
    startTurn: (command) =>
      Effect.sync(() => {
        sent.push(command);
        return { sequence: sent.length };
      }),
    ...overrides,
  };
  const handlers = BridgeToolkitHandlersLive.pipe(
    Layer.provide(
      Layer.succeed(
        Environments,
        Environments.of({
          enabled: Effect.succeed([environment]),
          get: () => Effect.succeed(environment),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const sendMessage = (message: string) =>
    Effect.gen(function* () {
      const toolkit = yield* BridgeToolkit;
      const results = yield* toolkit
        .handle("send_session_message", { server_id: "home", session_id: session.id, message })
        .pipe(Effect.flatMap(Stream.runCollect));
      const { result } = results[0]!;
      // A tool failure fails the stream, so anything else here is unexpected.
      return "delivery" in result ? result : yield* Effect.die(result);
    }).pipe(Effect.provide(handlers));
  const answer = (answers: Record<string, string | string[]>, requestId = "question-request") =>
    Effect.gen(function* () {
      const toolkit = yield* BridgeToolkit;
      return yield* toolkit
        .handle("answer_session_question", {
          server_id: "home",
          session_id: session.id,
          request_id: requestId,
          answers,
        })
        .pipe(Effect.flatMap(Stream.runCollect));
    }).pipe(Effect.provide(handlers));
  const approve = (decision: ProviderApprovalDecision, requestId = "approval-request") =>
    Effect.gen(function* () {
      const toolkit = yield* BridgeToolkit;
      return yield* toolkit
        .handle("respond_to_session_approval", {
          server_id: "home",
          session_id: session.id,
          request_id: requestId,
          decision,
        })
        .pipe(Effect.flatMap(Stream.runCollect));
    }).pipe(Effect.provide(handlers));
  const create = (
    checkout?: CreateSessionInput["checkout"],
    selection: Pick<CreateSessionInput, "agent" | "model" | "reasoning_effort"> = {},
  ) =>
    Effect.gen(function* () {
      const toolkit = yield* BridgeToolkit;
      return yield* toolkit
        .handle("create_session", {
          server_id: "home",
          project_id: "project-1",
          task: "Fix the test",
          ...(checkout === undefined ? {} : { checkout }),
          ...selection,
        })
        .pipe(Effect.flatMap(Stream.runCollect));
    }).pipe(Effect.provide(handlers));
  const inspectModel = (model: string, agent?: string) =>
    Effect.gen(function* () {
      const toolkit = yield* BridgeToolkit;
      return yield* toolkit
        .handle("get_model_capabilities", { server_id: "home", model, agent })
        .pipe(Effect.flatMap(Stream.runCollect));
    }).pipe(Effect.provide(handlers));
  const status = Effect.gen(function* () {
    const toolkit = yield* BridgeToolkit;
    return yield* toolkit
      .handle("get_session_status", { server_id: "home", session_id: session.id })
      .pipe(Effect.flatMap(Stream.runCollect));
  }).pipe(Effect.provide(handlers));
  return { sent, sendMessage, answer, approve, create, inspectModel, status };
}

const completed = thread({
  latestTurn: { ...thread().latestTurn!, state: "completed", completedAt: at(20) },
  session: { ...thread().session!, status: "ready", activeTurnId: null },
  messages: [...thread().messages, message("reply", "assistant", "Fixed the retry loop", 20)],
});

describe("send_session_message", () => {
  it.effect("continues the session's own thread, as a new turn or into the running one", () =>
    Effect.gen(function* () {
      const finished = bridgeWith(completed);
      const sent = yield* finished.sendMessage("Also update the docs");
      expect(sent).toMatchObject({ session_id: completed.id, delivery: "new_turn" });
      // The returned cursor makes the next status report the follow-up, not the earlier turn.
      const followedUp = thread({
        ...completed,
        messages: [...completed.messages, message("follow-up", "user", "Also update the docs", 25)],
      });
      expect(
        summarizeSession(followedUp, { cursor: sent.cursor, limit: 10, now: NOW }).updates.map(
          (update) => update.text,
        ),
      ).toEqual(["Also update the docs"]);
      const [command] = finished.sent;
      expect(command).toMatchObject({
        type: "thread.turn.start",
        threadId: completed.id,
        message: { role: "user", text: "Also update the docs" },
        runtimeMode: completed.runtimeMode,
        interactionMode: completed.interactionMode,
      });
      // A bootstrap would create another thread; a model selection would switch agents.
      expect(command).not.toHaveProperty("bootstrap");
      expect(command).not.toHaveProperty("modelSelection");

      const running = bridgeWith(thread());
      expect(yield* running.sendMessage("Skip the e2e suite")).toMatchObject({
        delivery: "during_turn",
      });
      expect(running.sent).toHaveLength(1);
    }),
  );

  it.effect("refuses while the agent waits for an approval, sending nothing", () =>
    Effect.gen(function* () {
      const waiting = bridgeWith(
        thread({
          activities: [
            activity(
              "ask",
              "approval.requested",
              3,
              { requestId: "request-1", requestKind: "command", detail: "rm -rf build" },
              { tone: "approval" },
            ),
          ],
        }),
      );
      const error = yield* Effect.flip(waiting.sendMessage("Go ahead"));
      expect(error.message).toContain("waiting for an approval or an answer");
      expect(waiting.sent).toEqual([]);
    }),
  );
});

const questionRequest = activity("questions", "user-input.requested", 3, {
  requestId: "question-request",
  questions: [
    {
      id: " choice ",
      header: "Choice",
      question: "Which one?",
      allowCustomAnswer: false,
      options: [
        { label: "First", value: " first-id ", description: "Use first" },
        { label: "Second", value: "second", description: "Use second" },
      ],
    },
    {
      id: "many",
      header: "Many",
      question: "Which ones?",
      multiSelect: true,
      allowCustomAnswer: false,
      options: [
        { label: "A", description: "" },
        { label: "B", description: "" },
      ],
    },
    { id: "text", header: "Text", question: "Instructions?", options: [] },
  ],
});
const validAnswers = {
  " choice ": " first-id ",
  many: ["A", "B"],
  text: "  Keep this exact text.\nPlease.  ",
};
const approvalRequest = activity("approval", "approval.requested", 3, {
  requestId: "approval-request",
  requestKind: "command",
  detail: "run deployment",
  appName: "Shell",
  options: [
    { decision: "accept", label: "Approve", warning: "Runs a deployment" },
    { decision: "decline", label: "Deny" },
  ],
});

describe("pending request responses", () => {
  it.effect(
    "answers all questions with exact native IDs, choices, multi-selection and free text",
    () =>
      Effect.gen(function* () {
        const bridge = bridgeWith(thread({ activities: [questionRequest] }));
        const response = yield* bridge.answer(validAnswers);
        expect(response[0]?.result).toMatchObject({
          accepted: true,
          request_id: "question-request",
          cursor: at(3),
        });
        expect(bridge.sent[0]).toMatchObject({
          type: "thread.user-input.respond",
          threadId: "thread-1",
          requestId: "question-request",
          answers: validAnswers,
        });
        expect(bridge.sent[0]).not.toHaveProperty("bootstrap");
      }),
  );
  it.effect(
    "rejects missing/extra IDs, labels in place of values, unsupported custom text and invalid multi-selection",
    () =>
      Effect.gen(function* () {
        const bridge = bridgeWith(thread({ activities: [questionRequest] }));
        for (const answers of [
          { text: "Only one" },
          { ...validAnswers, extra: "No" },
          { ...validAnswers, " choice ": "First" },
          { ...validAnswers, " choice ": "Custom" },
          { ...validAnswers, " choice ": [" first-id ", "second"] },
          { ...validAnswers, many: ["A", "Invalid"] },
          { ...validAnswers, many: [] },
          { ...validAnswers, many: ["A", "A"] },
          { ...validAnswers, text: " " },
        ])
          expect((yield* Effect.flip(bridge.answer(answers))).message).toMatch(/question|Answer/);
        expect(bridge.sent).toEqual([]);
      }),
  );
  it.effect("rejects unknown and resolved requests without sending a response", () =>
    Effect.gen(function* () {
      for (const kind of ["user-input.resolved", "provider.user-input.respond.failed"]) {
        const bridge = bridgeWith(
          thread({
            activities: [
              questionRequest,
              activity("closed", kind, 4, {
                requestId: "question-request",
                detail: "Stale pending user-input request",
              }),
            ],
          }),
        );
        expect((yield* Effect.flip(bridge.answer(validAnswers))).message).toContain(
          "no longer pending",
        );
        expect(bridge.sent).toEqual([]);
      }
      expect(
        (yield* Effect.flip(bridgeWith(thread()).answer(validAnswers, "missing"))).message,
      ).toContain("no longer pending");
    }),
  );
  it.effect("answers message-mode questions through the same orchestration command", () =>
    Effect.gen(function* () {
      const bridge = bridgeWith(
        thread({
          activities: [
            activity("async", "user-input.requested", 3, {
              requestId: "question-request",
              responseMode: "message",
              questions: [{ id: "text", header: "Text", question: "What next?", options: [] }],
            }),
          ],
        }),
      );
      yield* bridge.answer({ text: "Continue with docs" });
      expect(bridge.sent[0]).toMatchObject({
        type: "thread.user-input.respond",
        answers: { text: "Continue with docs" },
      });
    }),
  );
  it.effect("submits explicit approve/deny decisions and rejects unoffered permission scope", () =>
    Effect.gen(function* () {
      for (const decision of ["accept", "decline"] as const) {
        const bridge = bridgeWith(thread({ activities: [approvalRequest] }));
        yield* bridge.approve(decision);
        expect(bridge.sent[0]).toMatchObject({
          type: "thread.approval.respond",
          requestId: "approval-request",
          decision,
        });
      }
      const bridge = bridgeWith(thread({ activities: [approvalRequest] }));
      for (const decision of ["acceptAlways", "acceptForSession", "cancel"] as const)
        expect((yield* Effect.flip(bridge.approve(decision))).message).toContain("not offered");
      expect(bridge.sent).toEqual([]);
    }),
  );
  it.effect(
    "uses T3's default decisions for legacy approvals and honors provider-specific scope",
    () =>
      Effect.gen(function* () {
        const legacy = activity("legacy", "approval.requested", 3, {
          requestId: "approval-request",
          requestKind: "file-change",
        });
        for (const decision of ["accept", "decline", "cancel", "acceptForSession"] as const)
          yield* bridgeWith(thread({ activities: [legacy] })).approve(decision);
        expect(
          (yield* Effect.flip(bridgeWith(thread({ activities: [legacy] })).approve("acceptAlways")))
            .message,
        ).toContain("not offered");
        const bridge = bridgeWith(
          thread({
            activities: [
              activity("scoped", "approval.requested", 3, {
                requestId: "approval-request",
                requestKind: "permission",
                options: [{ decision: "acceptAlways", label: "Always allow" }],
              }),
            ],
          }),
        );
        yield* bridge.approve("acceptAlways");
        expect(bridge.sent[0]).toMatchObject({ decision: "acceptAlways" });
      }),
  );
  it.effect("rejects resolved approvals and preserves server rejection", () =>
    Effect.gen(function* () {
      const resolved = bridgeWith(
        thread({
          activities: [
            approvalRequest,
            activity("resolved", "approval.resolved", 4, { requestId: "approval-request" }),
          ],
        }),
      );
      expect((yield* Effect.flip(resolved.approve("accept"))).message).toContain(
        "no longer pending",
      );
      expect(resolved.sent).toEqual([]);
      const denied = bridgeWith(thread({ activities: [approvalRequest] }), {
        dispatchCommand: () => Effect.fail(new BridgeError({ message: "Permission denied" })),
      });
      expect((yield* Effect.flip(denied.approve("accept"))).message).toBe("Permission denied");
    }),
  );
});

describe("session checkout selection", () => {
  it.effect(
    "keeps omitted and null checkout local even when project settings prefer worktrees",
    () =>
      Effect.gen(function* () {
        for (const checkout of [undefined, null, { mode: "local" as const }]) {
          const bridge = bridgeWith(thread());
          yield* bridge.create(checkout);
          expect(bridge.sent[0]).toMatchObject({
            bootstrap: { createThread: { branch: null, worktreePath: null } },
          });
          expect(bridge.sent[0]).not.toHaveProperty("bootstrap.prepareWorktree");
        }
      }),
  );
  it.effect("prepares an isolated worktree with canonical bootstrap and configured setup", () =>
    Effect.gen(function* () {
      const bridge = bridgeWith(thread(), {
        thread: () =>
          Effect.succeed({
            snapshotSequence: 2,
            thread: thread({ branch: "feature/test", worktreePath: "/worktrees/test" }),
          }),
      });
      const response = yield* bridge.create({
        mode: "worktree",
        base_branch: "main",
        branch: "feature/test",
        start_from_origin: true,
      });
      expect(bridge.sent[0]).toMatchObject({
        bootstrap: {
          prepareWorktree: {
            projectCwd: "/project",
            baseBranch: "main",
            branch: "feature/test",
            startFromOrigin: true,
            requireWorktree: true,
          },
          runSetupScript: true,
          createThread: { branch: "main", worktreePath: null },
        },
      });
      expect(response[0]?.result).toMatchObject({
        branch: "feature/test",
        worktree_path: "/worktrees/test",
      });
      const automatic = bridgeWith(thread(), {
        thread: () =>
          Effect.succeed({
            snapshotSequence: 2,
            thread: thread({ worktreePath: "/worktrees/auto" }),
          }),
      });
      yield* automatic.create({
        mode: "worktree",
        base_branch: "origin/main",
        run_setup_script: false,
      });
      expect(automatic.sent[0]).toMatchObject({
        bootstrap: {
          prepareWorktree: {
            branch: expect.stringMatching(/^t3code\/[0-9a-f]{8}$/),
            startFromOrigin: false,
          },
          runSetupScript: false,
        },
      });
    }),
  );
  it.effect(
    "switches or creates local branches using T3 RPCs before starting, and sends no turn on conflicts",
    () =>
      Effect.gen(function* () {
        const operations: string[] = [];
        const bridge = bridgeWith(thread(), {
          switchRef: (input) =>
            Effect.sync(() => {
              operations.push(`switch:${input.cwd}:${input.refName}`);
              return { refName: "feature" };
            }),
          createRef: (input) =>
            Effect.sync(() => {
              operations.push(`create:${input.cwd}:${input.refName}:${input.switchRef}`);
              return { refName: input.refName };
            }),
        });
        yield* bridge.create({ mode: "local", branch: "origin/feature" });
        yield* bridge.create({ mode: "local", branch: "new", create_branch: true });
        expect(operations).toEqual(["switch:/project:origin/feature", "create:/project:new:true"]);
        expect(bridge.sent[0]).toMatchObject({
          bootstrap: { createThread: { branch: "feature", worktreePath: null } },
        });
        expect(bridge.sent[1]).toMatchObject({ bootstrap: { createThread: { branch: "new" } } });
        const conflict = bridgeWith(thread(), {
          switchRef: () => Effect.fail(new BridgeError({ message: "Branch is in use" })),
        });
        expect(
          (yield* Effect.flip(conflict.create({ mode: "local", branch: "in-use" }))).message,
        ).toBe("Branch is in use");
        expect(conflict.sent).toEqual([]);
        expect(
          (yield* Effect.flip(bridge.create({ mode: "local", create_branch: true }))).message,
        ).toContain("requires");
      }),
  );
  it.effect(
    "resolves an existing worktree from the project's refs, including pagination and the main checkout",
    () =>
      Effect.gen(function* () {
        const cursors: Array<number | undefined> = [];
        const refs: VcsListRefsResult = {
          isRepo: true,
          hasPrimaryRemote: true,
          totalCount: 2,
          nextCursor: null,
          refs: [
            {
              name: "feature",
              current: false,
              isDefault: false,
              worktreePath: "/worktrees/feature",
            },
          ],
        };
        const bridge = bridgeWith(thread(), {
          listRefs: (input) =>
            Effect.sync(() => {
              cursors.push(input.cursor);
              return input.cursor === undefined ? { ...refs, refs: [], nextCursor: 1 } : refs;
            }),
        });
        yield* bridge.create({ mode: "existing_worktree", branch: "feature" });
        expect(cursors).toEqual([undefined, 1]);
        expect(bridge.sent[0]).toMatchObject({
          bootstrap: { createThread: { branch: "feature", worktreePath: "/worktrees/feature" } },
        });
        expect(bridge.sent[0]).not.toHaveProperty("bootstrap.prepareWorktree");
        const main = bridgeWith(thread(), {
          listRefs: () =>
            Effect.succeed({ ...refs, refs: [{ ...refs.refs[0]!, worktreePath: "/project" }] }),
        });
        yield* main.create({ mode: "existing_worktree", branch: "feature" });
        expect(main.sent[0]).toMatchObject({ bootstrap: { createThread: { worktreePath: null } } });
        const missing = bridgeWith(thread(), {
          listRefs: () => Effect.succeed({ ...refs, refs: [] }),
        });
        expect(
          (yield* Effect.flip(missing.create({ mode: "existing_worktree", branch: "missing" })))
            .message,
        ).toContain("no existing worktree");
        expect(missing.sent).toEqual([]);
      }),
  );
  it.effect(
    "returns the server's worktree/bootstrap failure without pretending creation succeeded",
    () =>
      Effect.gen(function* () {
        const bridge = bridgeWith(thread(), {
          startTurn: () =>
            Effect.fail(new BridgeError({ message: "Worktree branch already exists" })),
          thread: () => Effect.die("must not read a failed creation"),
        });
        expect(
          (yield* Effect.flip(
            bridge.create({ mode: "worktree", base_branch: "main", branch: "existing" }),
          )).message,
        ).toBe("Worktree branch already exists");
      }),
  );
  it.effect("rejects worktree mode on servers that can silently fall back to local", () =>
    Effect.gen(function* () {
      const bridge = bridgeWith(thread(), {
        serverConfig: Effect.succeed({
          ...config,
          environment: { ...config.environment, capabilities: { repositoryIdentity: false } },
        }),
      });
      expect(
        (yield* Effect.flip(bridge.create({ mode: "worktree", base_branch: "main" }))).message,
      ).toContain("cannot guarantee");
      expect(bridge.sent).toEqual([]);
    }),
  );
});

/** The same server once Codex reports GPT-6 Astra's effort levels; GPT-5.5 still reports none. */
const effortConfig = {
  ...config,
  providers: [
    Schema.decodeSync(ServerProvider)({
      ...Schema.encodeSync(ServerProvider)(config.providers[0]!),
      models: [
        {
          slug: "gpt-6-astra",
          name: "GPT-6 Astra",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Extra High" },
                ],
                currentValue: "medium",
              },
            ],
          },
        },
        { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null, isDefault: true },
      ],
    }),
  ],
};

describe("reasoning effort", () => {
  it.effect("starts the session exactly as before when reasoning_effort is omitted or null", () =>
    Effect.gen(function* () {
      for (const reasoningEffort of [undefined, null]) {
        const bridge = bridgeWith(thread(), { serverConfig: Effect.succeed(effortConfig) });
        const response = yield* bridge.create(undefined, { reasoning_effort: reasoningEffort });
        const selection = { instanceId: "codex", model: "gpt-5.5" };
        expect(bridge.sent[0]).toMatchObject({
          modelSelection: selection,
          bootstrap: { createThread: { modelSelection: selection } },
        });
        expect(bridge.sent[0]).not.toHaveProperty("modelSelection.options");
        expect(response[0]?.result).toMatchObject({ model: "gpt-5.5", reasoning_effort: null });
      }
    }),
  );

  it.effect("forwards a supported effort to the turn and the thread it creates", () =>
    Effect.gen(function* () {
      const bridge = bridgeWith(thread(), { serverConfig: Effect.succeed(effortConfig) });
      const response = yield* bridge.create(undefined, {
        model: "astra",
        reasoning_effort: "Extra High",
      });
      const selection = {
        instanceId: "codex",
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      };
      expect(bridge.sent[0]).toMatchObject({
        modelSelection: selection,
        bootstrap: { createThread: { modelSelection: selection } },
      });
      expect(response[0]?.result).toMatchObject({
        agent: "codex",
        model: "gpt-6-astra",
        reasoning_effort: "xhigh",
      });
    }),
  );

  it.effect("rejects an effort the selected model cannot take, before starting anything", () =>
    Effect.gen(function* () {
      const bridge = bridgeWith(thread(), { serverConfig: Effect.succeed(effortConfig) });
      expect(
        (yield* Effect.flip(bridge.create(undefined, { model: "astra", reasoning_effort: "max" })))
          .message,
      ).toBe(
        'Model "gpt-6-astra" on agent "codex" does not support reasoning effort "max". Supported values: low, medium, high, xhigh.',
      );
      // The project default, GPT-5.5, comes from a server that reports no options for it.
      expect(
        (yield* Effect.flip(bridge.create(undefined, { reasoning_effort: "high" }))).message,
      ).toContain("does not report its reasoning effort options");
      expect(bridge.sent).toEqual([]);
    }),
  );

  it.effect("describes a model through the same names create_session accepts", () =>
    Effect.gen(function* () {
      const bridge = bridgeWith(thread(), { serverConfig: Effect.succeed(effortConfig) });
      expect((yield* bridge.inspectModel("astra", "Codex"))[0]?.result).toEqual({
        server_id: "home",
        agent: "codex",
        model: "gpt-6-astra",
        name: "GPT-6 Astra",
        reasoning_effort_support: "configurable",
        reasoning_efforts: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
          { value: "xhigh", name: "Extra High" },
        ],
        default_reasoning_effort: "medium",
      });
      expect((yield* bridge.inspectModel("GPT-5.5"))[0]?.result).toMatchObject({
        reasoning_effort_support: "unknown",
        reasoning_efforts: [],
      });
      expect((yield* Effect.flip(bridge.inspectModel("claude"))).message).toContain(
        'No agent on this server has a model matching "claude"',
      );
    }),
  );

  it.effect("reports the effort a session was started with", () =>
    Effect.gen(function* () {
      const tuned = thread({
        modelSelection: {
          ...thread().modelSelection,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      expect((yield* bridgeWith(tuned).status)[0]?.result).toMatchObject({
        model: "gpt-5.5",
        reasoning_effort: "high",
      });
      expect((yield* bridgeWith(thread()).status)[0]?.result).toMatchObject({
        reasoning_effort: null,
      });
    }),
  );
});

describe("MCP parameter schemas", () => {
  it("accepts legacy creation inputs, nullable optional fields, and the supported checkout choices", () => {
    const decode = Schema.decodeUnknownSync(BridgeToolkit.tools.create_session.parametersSchema);
    const input = { server_id: "home", project_id: "project-1", task: "Fix the test" };
    expect(decode(input)).not.toHaveProperty("checkout");
    expect(decode(input)).not.toHaveProperty("reasoning_effort");
    expect(
      decode({ ...input, checkout: null, agent: null, model: null, reasoning_effort: null }),
    ).toMatchObject({ checkout: null, reasoning_effort: null });
    expect(decode({ ...input, reasoning_effort: " high " })).toMatchObject({
      reasoning_effort: "high",
    });
    expect(() => decode({ ...input, reasoning_effort: " " })).toThrow();
    expect(
      decode({
        ...input,
        checkout: { mode: "worktree", base_branch: "main", branch: null, run_setup_script: null },
      }),
    ).toMatchObject({ checkout: { mode: "worktree", base_branch: "main" } });
    for (const checkout of [
      { mode: "worktree" },
      { mode: "existing_worktree" },
      { mode: "unknown" },
      { mode: "worktree", base_branch: " " },
    ]) {
      expect(() => decode({ ...input, checkout })).toThrow();
    }
  });
  it("preserves opaque question IDs and answer whitespace and rejects unsupported payload types", () => {
    const decode = Schema.decodeUnknownSync(
      BridgeToolkit.tools.answer_session_question.parametersSchema,
    );
    const input = {
      server_id: "home",
      session_id: "thread-1",
      request_id: "request-1",
      answers: validAnswers,
    };
    expect(decode(input).answers).toEqual(validAnswers);
    for (const answers of [
      { question: true },
      { question: null },
      { question: { text: "Answer" } },
      { question: [1] },
    ])
      expect(() => decode({ ...input, answers })).toThrow();
    const approve = Schema.decodeUnknownSync(
      BridgeToolkit.tools.respond_to_session_approval.parametersSchema,
    );
    expect(() =>
      approve({
        server_id: "home",
        session_id: "thread-1",
        request_id: "request-1",
        decision: "yes",
      }),
    ).toThrow();
  });
});
