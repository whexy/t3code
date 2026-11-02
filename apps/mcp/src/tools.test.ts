import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type VcsListRefsResult,
  OrchestrationV2ShellSnapshot,
  ProviderApprovalDecision,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { BridgeError, type T3Environment } from "./environment.ts";
import {
  appThread,
  approvalItem,
  at,
  bridgeLayer,
  callTool,
  command,
  fakeEnvironment,
  NOW,
  projection,
  questionItem,
  run,
  runtimeRequest,
  threadId,
  threadServer,
  userMessage,
} from "./testing.ts";
import { waitForThreadState } from "./threadWatch.ts";
import { BridgeToolkit } from "./tools.ts";

const config = Schema.decodeSync(ServerConfig)({
  environment: {
    environmentId: "env-home",
    label: "Home",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: {},
    orchestrationProtocolVersion: 2,
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
const shell = Schema.decodeSync(OrchestrationV2ShellSnapshot)({
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [
    {
      id: "project-1",
      title: "Project",
      workspaceRoot: "/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  threads: [],
  archivedThreads: [],
});

type CreateSessionInput = typeof BridgeToolkit.tools.create_session.parametersSchema.Type;

/**
 * A server that launches threads. Root and existing checkouts start at once;
 * a new worktree reports `preparation` to subscribers after launch returns.
 */
function launchingServer(
  overrides: Partial<T3Environment> = {},
  preparation: (
    launched: OrchestrationV2ThreadProjection,
  ) => ReadonlyArray<OrchestrationV2ThreadProjection> = (launched) => [launched],
) {
  const launches: Array<OrchestrationV2ThreadLaunchInput> = [];
  let launched: OrchestrationV2ThreadProjection | undefined;
  const environment = fakeEnvironment({
    shell: Effect.succeed(shell),
    serverConfig: Effect.succeed(config),
    launchThread: (input) =>
      Effect.sync(() => {
        launches.push(input);
        const strategy = input.workspaceStrategy;
        launched = projection({
          thread: appThread({
            id: input.threadId!,
            branch: strategy.branch ?? null,
            worktreePath: strategy.type === "existing_worktree" ? strategy.worktreePath : null,
          }),
          runs: [
            run({
              userMessageId: input.initialMessage!.messageId!,
              status: strategy.type === "worktree" ? "preparing" : "starting",
              startedAt: null,
            }),
          ],
        });
        return launched;
      }),
    waitForThread: (_threadId, ready) =>
      waitForThreadState(
        Stream.fromIterable(
          preparation(launched!).map((projection) => ({
            kind: "snapshot" as const,
            snapshotSequence: 2,
            projection,
          })),
        ),
        ready,
      ),
    ...overrides,
  });
  const create = (
    checkout?: CreateSessionInput["checkout"],
    selection: Pick<CreateSessionInput, "agent" | "model" | "reasoning_effort"> = {},
  ) =>
    callTool("create_session", {
      server_id: "home",
      project_id: "project-1",
      task: "Fix the test",
      ...(checkout === undefined ? {} : { checkout }),
      ...selection,
    }).pipe(Effect.provide(bridgeLayer(environment)));
  const listProjects = callTool("list_projects", {}).pipe(Effect.provide(bridgeLayer(environment)));
  return { launches, create, listProjects };
}

/** The worktree the server prepares for the launched thread, after one preparing frame. */
const preparedWorktree =
  (branch: string, worktreePath: string) => (launched: OrchestrationV2ThreadProjection) => [
    launched,
    {
      ...launched,
      thread: { ...launched.thread, branch, worktreePath },
      runs: launched.runs.map((candidate) => ({ ...candidate, status: "starting" as const })),
    },
  ];

const questions = [
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
      { label: "A", description: "First letter" },
      { label: "B", description: "Second letter" },
    ],
  },
  { id: "text", header: "Text", question: "Instructions?", options: [] },
];
const validAnswers = {
  " choice ": " first-id ",
  many: ["A", "B"],
  text: "  Keep this exact text.\nPlease.  ",
};
const user = userMessage("user-1", "Fix the flaky test", 1);
const asking = (overrides: Parameters<typeof runtimeRequest>[2] = {}) =>
  projection({
    items: [user, questionItem("question-request", 3, questions)],
    runtimeRequests: [runtimeRequest("question-request", "user_input", overrides)],
  });
const approvalRequest = approvalItem("approval-request", 3, {
  prompt: "run deployment",
  appName: "Shell",
  options: [
    { decision: "accept", label: "Approve", warning: "Runs a deployment" },
    { decision: "decline", label: "Deny" },
  ],
});
const approving = (item = approvalRequest, overrides: Parameters<typeof runtimeRequest>[2] = {}) =>
  projection({
    items: [user, item],
    runtimeRequests: [runtimeRequest("approval-request", "command", overrides)],
  });

const answer = (answers: Record<string, string | string[]>, requestId = "question-request") =>
  callTool("respond_to_session", {
    server_id: "home",
    session_id: threadId,
    request_id: requestId,
    answers,
  });
const approve = (decision: ProviderApprovalDecision, requestId = "approval-request") =>
  callTool("respond_to_session", {
    server_id: "home",
    session_id: threadId,
    request_id: requestId,
    decision,
  });

describe("pending request responses", () => {
  it.effect(
    "answers all questions with exact native IDs, choices, multi-selection and free text",
    () => {
      const server = threadServer(asking());
      return Effect.gen(function* () {
        expect(yield* answer(validAnswers)).toMatchObject({
          accepted: true,
          request_id: "question-request",
          cursor: at(3),
        });
        expect(server.sent).toEqual([
          {
            type: "runtime-request.respond",
            commandId: expect.any(String),
            threadId,
            requestId: "question-request",
            answers: validAnswers,
          },
        ]);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect(
    "rejects missing/extra IDs, labels in place of values, unsupported custom text and invalid multi-selection",
    () => {
      const server = threadServer(asking());
      return Effect.gen(function* () {
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
          expect((yield* Effect.flip(answer(answers))).message).toMatch(/question|Answer/);
        expect(server.sent).toEqual([]);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect("rejects resolved, expired, and unknown requests without sending a response", () =>
    Effect.gen(function* () {
      for (const [session, requestId] of [
        [asking({ status: "resolved" }), "question-request"],
        [asking({ status: "expired" }), "question-request"],
        [asking(), "missing"],
      ] as const) {
        const server = threadServer(session);
        expect(
          (yield* Effect.flip(answer(validAnswers, requestId).pipe(Effect.provide(server.layer))))
            .message,
        ).toContain("no longer pending");
        expect(server.sent).toEqual([]);
      }
    }),
  );

  it.effect("answers message-mode questions through the same runtime request command", () => {
    const server = threadServer(
      projection({
        items: [
          user,
          questionItem(
            "question-request",
            3,
            [{ id: "text", header: "Text", question: "What next?", options: [] }],
            { responseMode: "message" },
          ),
        ],
        runtimeRequests: [runtimeRequest("question-request", "user_input")],
      }),
    );
    return Effect.gen(function* () {
      yield* answer({ text: "Continue with docs" });
      expect(server.sent[0]).toMatchObject({
        type: "runtime-request.respond",
        answers: { text: "Continue with docs" },
      });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("submits explicit approve/deny decisions and rejects unoffered permission scope", () =>
    Effect.gen(function* () {
      for (const decision of ["accept", "decline"] as const) {
        const server = threadServer(approving());
        yield* approve(decision).pipe(Effect.provide(server.layer));
        expect(server.sent).toEqual([
          {
            type: "runtime-request.respond",
            commandId: expect.any(String),
            threadId,
            requestId: "approval-request",
            decision,
          },
        ]);
      }
      const server = threadServer(approving());
      for (const decision of ["acceptAlways", "acceptForSession", "cancel"] as const)
        expect(
          (yield* Effect.flip(approve(decision).pipe(Effect.provide(server.layer)))).message,
        ).toContain("not offered");
      expect(server.sent).toEqual([]);
    }),
  );

  it.effect("uses T3's default decisions when the provider offers none", () =>
    Effect.gen(function* () {
      const plain = approvalItem("approval-request", 3, { requestKind: "file-change" });
      for (const decision of ["accept", "decline", "cancel", "acceptForSession"] as const) {
        const server = threadServer(approving(plain));
        yield* approve(decision).pipe(Effect.provide(server.layer));
        expect(server.sent).toHaveLength(1);
      }
      const server = threadServer(approving(plain));
      expect(
        (yield* Effect.flip(approve("acceptAlways").pipe(Effect.provide(server.layer)))).message,
      ).toContain("not offered");
      const scoped = threadServer(
        approving(
          approvalItem("approval-request", 3, {
            requestKind: "permission",
            options: [{ decision: "acceptAlways", label: "Always allow" }],
          }),
        ),
      );
      yield* approve("acceptAlways").pipe(Effect.provide(scoped.layer));
      expect(scoped.sent[0]).toMatchObject({ decision: "acceptAlways" });
    }),
  );

  it.effect(
    "rejects a response of the wrong kind, or of both or neither kinds, sending nothing",
    () =>
      Effect.gen(function* () {
        const questionServer = threadServer(asking());
        expect(
          (yield* Effect.flip(
            approve("accept", "question-request").pipe(Effect.provide(questionServer.layer)),
          )).message,
        ).toContain("is a question; respond with answers");
        expect(questionServer.sent).toEqual([]);
        const approvalServer = threadServer(approving());
        expect(
          (yield* Effect.flip(
            answer(validAnswers, "approval-request").pipe(Effect.provide(approvalServer.layer)),
          )).message,
        ).toContain("is an approval; respond with decision");
        for (const response of [{}, { answers: validAnswers, decision: "accept" as const }]) {
          const error = yield* Effect.flip(
            callTool("respond_to_session", {
              server_id: "home",
              session_id: threadId,
              request_id: "approval-request",
              ...response,
            }).pipe(Effect.provide(approvalServer.layer)),
          );
          expect(error.message).toContain("exactly one of answers");
        }
        expect(approvalServer.sent).toEqual([]);
      }),
  );

  it.effect("rejects resolved approvals and preserves server rejection", () =>
    Effect.gen(function* () {
      const resolved = threadServer(approving(approvalRequest, { status: "resolved" }));
      expect(
        (yield* Effect.flip(approve("accept").pipe(Effect.provide(resolved.layer)))).message,
      ).toContain("no longer pending");
      expect(resolved.sent).toEqual([]);
      const denied = threadServer(approving(), undefined, {
        dispatch: () => Effect.fail(new BridgeError({ message: "Permission denied" })),
      });
      expect(
        (yield* Effect.flip(approve("accept").pipe(Effect.provide(denied.layer)))).message,
      ).toBe("Permission denied");
    }),
  );
});

describe("session checkout selection", () => {
  it.effect(
    "launches at the project root for omitted, null, and local checkouts, even when settings prefer worktrees",
    () =>
      Effect.gen(function* () {
        for (const checkout of [undefined, null, { mode: "local" as const }]) {
          const server = launchingServer({
            waitForThread: () => Effect.die("a root launch must not wait"),
          });
          expect(yield* server.create(checkout)).toMatchObject({
            state: "queued",
            branch: null,
            worktree_path: null,
          });
          expect(server.launches).toEqual([
            {
              commandId: expect.any(String),
              creationSource: "mcp",
              threadId: expect.any(String),
              projectId: "project-1",
              title: "Fix the test",
              generateTitle: true,
              modelSelection: { instanceId: "codex", model: "gpt-5.5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: {
                messageId: expect.any(String),
                text: "Fix the test",
                attachments: [],
              },
            },
          ]);
        }
      }),
  );

  it.effect("returns a new worktree's branch and path once the server has prepared it", () =>
    Effect.gen(function* () {
      const server = launchingServer({}, preparedWorktree("feature/test", "/worktrees/test"));
      const response = yield* server.create({
        mode: "worktree",
        base_branch: "main",
        branch: "feature/test",
        start_from_origin: true,
      });
      expect(server.launches[0]?.workspaceStrategy).toEqual({
        type: "worktree",
        baseRef: "main",
        branch: "feature/test",
        startFromOrigin: true,
      });
      expect(response).toMatchObject({ branch: "feature/test", worktree_path: "/worktrees/test" });

      const automatic = launchingServer({}, preparedWorktree("t3code/1a2b3c4d", "/worktrees/auto"));
      expect(
        yield* automatic.create({ mode: "worktree", base_branch: "origin/main" }),
      ).toMatchObject({ branch: "t3code/1a2b3c4d", worktree_path: "/worktrees/auto" });
      // The server names the branch when none is given.
      expect(automatic.launches[0]?.workspaceStrategy).toEqual({
        type: "worktree",
        baseRef: "origin/main",
        startFromOrigin: false,
      });
    }),
  );

  it.effect("reports a failed worktree preparation with the server's reason", () =>
    Effect.gen(function* () {
      const server = launchingServer({}, (launched) => [
        launched,
        {
          ...launched,
          runs: launched.runs.map((candidate) => ({ ...candidate, status: "failed" as const })),
          turnItems: [
            {
              ...command("failure", "", 5),
              type: "error",
              status: "failed",
              runId: launched.runs[0]!.id,
              failure: {
                class: "validation_error",
                message: "Workspace preparation failed during provision worktree: branch exists",
                code: "workspace_preparation_failed",
                retryable: false,
              },
            },
          ],
        },
      ]);
      const error = yield* Effect.flip(
        server.create({ mode: "worktree", base_branch: "main", branch: "existing" }),
      );
      expect(error.message).toContain(
        "could not prepare the worktree: Workspace preparation failed",
      );
      const rejected = launchingServer({
        launchThread: () => Effect.fail(new BridgeError({ message: "Project not found." })),
      });
      expect((yield* Effect.flip(rejected.create())).message).toBe("Project not found.");
    }),
  );

  it.effect(
    "switches or creates local branches using T3 RPCs before launching, and launches nothing on conflicts",
    () =>
      Effect.gen(function* () {
        const operations: string[] = [];
        const server = launchingServer({
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
        expect(yield* server.create({ mode: "local", branch: "origin/feature" })).toMatchObject({
          branch: "feature",
        });
        yield* server.create({ mode: "local", branch: "new", create_branch: true });
        expect(operations).toEqual(["switch:/project:origin/feature", "create:/project:new:true"]);
        expect(server.launches.map((launch) => launch.workspaceStrategy)).toEqual([
          { type: "root", branch: "feature" },
          { type: "root", branch: "new" },
        ]);
        const conflict = launchingServer({
          switchRef: () => Effect.fail(new BridgeError({ message: "Branch is in use" })),
        });
        expect(
          (yield* Effect.flip(conflict.create({ mode: "local", branch: "in-use" }))).message,
        ).toBe("Branch is in use");
        expect(conflict.launches).toEqual([]);
        expect(
          (yield* Effect.flip(server.create({ mode: "local", create_branch: true }))).message,
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
        const server = launchingServer({
          listRefs: (input) =>
            Effect.sync(() => {
              cursors.push(input.cursor);
              return input.cursor === undefined ? { ...refs, refs: [], nextCursor: 1 } : refs;
            }),
        });
        expect(
          yield* server.create({ mode: "existing_worktree", branch: "feature" }),
        ).toMatchObject({ branch: "feature", worktree_path: "/worktrees/feature" });
        expect(cursors).toEqual([undefined, 1]);
        expect(server.launches[0]?.workspaceStrategy).toEqual({
          type: "existing_worktree",
          worktreePath: "/worktrees/feature",
          branch: "feature",
        });
        const main = launchingServer({
          listRefs: () =>
            Effect.succeed({ ...refs, refs: [{ ...refs.refs[0]!, worktreePath: "/project" }] }),
        });
        yield* main.create({ mode: "existing_worktree", branch: "feature" });
        expect(main.launches[0]?.workspaceStrategy).toEqual({ type: "root", branch: "feature" });
        const missing = launchingServer({
          listRefs: () => Effect.succeed({ ...refs, refs: [] }),
        });
        expect(
          (yield* Effect.flip(missing.create({ mode: "existing_worktree", branch: "missing" })))
            .message,
        ).toContain("no existing worktree");
        expect(missing.launches).toEqual([]);
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
  it.effect("launches exactly as before when reasoning_effort is omitted or null", () =>
    Effect.gen(function* () {
      for (const reasoningEffort of [undefined, null]) {
        const server = launchingServer({ serverConfig: Effect.succeed(effortConfig) });
        const response = yield* server.create(undefined, { reasoning_effort: reasoningEffort });
        expect(server.launches[0]?.modelSelection).toEqual({
          instanceId: "codex",
          model: "gpt-5.5",
        });
        expect(response).toMatchObject({ model: "gpt-5.5", reasoning_effort: null });
      }
    }),
  );

  it.effect("launches the thread with a supported effort", () =>
    Effect.gen(function* () {
      const server = launchingServer({ serverConfig: Effect.succeed(effortConfig) });
      const response = yield* server.create(undefined, {
        model: "astra",
        reasoning_effort: "Extra High",
      });
      expect(server.launches[0]?.modelSelection).toEqual({
        instanceId: "codex",
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      });
      expect(response).toMatchObject({
        agent: "codex",
        model: "gpt-6-astra",
        reasoning_effort: "xhigh",
      });
    }),
  );

  it.effect("rejects an effort the selected model cannot take, before launching anything", () =>
    Effect.gen(function* () {
      const server = launchingServer({ serverConfig: Effect.succeed(effortConfig) });
      expect(
        (yield* Effect.flip(server.create(undefined, { model: "astra", reasoning_effort: "max" })))
          .message,
      ).toBe(
        'Model "gpt-6-astra" on agent "codex" does not support reasoning effort "max". Supported values: low, medium, high, xhigh.',
      );
      // The project default, GPT-5.5, comes from a server that reports no options for it.
      expect(
        (yield* Effect.flip(server.create(undefined, { reasoning_effort: "high" }))).message,
      ).toContain("does not report its reasoning effort options");
      expect(server.launches).toEqual([]);
    }),
  );

  it.effect("lists every model's efforts in list_projects, from the one server config", () =>
    Effect.gen(function* () {
      let configReads = 0;
      const server = launchingServer({
        serverConfig: Effect.sync(() => {
          configReads += 1;
          return effortConfig;
        }),
      });
      const listed = yield* server.listProjects;
      // The default model comes first.
      expect(listed.servers[0]?.agents?.[0]?.models).toEqual([
        {
          model: "gpt-5.5",
          name: "GPT-5.5",
          reasoning_effort_support: "unknown",
          reasoning_efforts: [],
          default_reasoning_effort: null,
        },
        {
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
        },
      ]);
      expect(configReads).toBe(1);
    }),
  );

  it.effect("reports the effort a session runs with", () =>
    Effect.gen(function* () {
      const tuned = projection({
        thread: appThread({
          modelSelection: {
            ...appThread().modelSelection,
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        }),
      });
      const status = (session: OrchestrationV2ThreadProjection) =>
        callTool("get_session_status", { server_id: "home", session_id: threadId }).pipe(
          Effect.provide(threadServer(session).layer),
        );
      expect(yield* status(tuned)).toMatchObject({ model: "gpt-5.5", reasoning_effort: "high" });
      expect(yield* status(projection())).toMatchObject({ reasoning_effort: null });
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
        checkout: { mode: "worktree", base_branch: "main", branch: null, start_from_origin: null },
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
      BridgeToolkit.tools.respond_to_session.parametersSchema,
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
    expect(() =>
      decode({
        server_id: "home",
        session_id: "thread-1",
        request_id: "request-1",
        decision: "yes",
      }),
    ).toThrow();
  });
});
