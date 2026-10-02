import {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  SourceControlCloneProtocol,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  buildProjectCreateCommand,
  normalizePastedCloneUrl,
  resolveAddProjectPath,
} from "@t3tools/client-runtime/operations/projects";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import {
  applyReasoningEffort,
  describeModelCapabilities,
  resolveModelSelection,
  selectedReasoningEffort,
  summarizeAgents,
} from "./agents.ts";
import { BridgeError, Environments } from "./environment.ts";
import { makeMessageQueue } from "./messageQueue.ts";
import { findSessions } from "./sessions.ts";
import { GetUsageTool, getUsage } from "./usage.ts";
import { latestCursor, summarizeSession, threadState } from "./status.ts";

const DEFAULT_UPDATE_LIMIT = 10;
const DEFAULT_SESSION_LIMIT = 10;
/** Tokens last 30 days; a week's notice lets the chat remind the user to re-pair. */
const TOKEN_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/** Trimmed, non-empty text whose description survives into the tool's JSON schema. */
const TextInput = (description: string) =>
  Schema.String.annotate({ description }).pipe(Schema.decodeTo(TrimmedNonEmptyString));

const ServerIdInput = TextInput("server_id from list_projects.");
const SessionIdInput = TextInput("session_id from create_session or list_sessions.");

/** OpenAI-style clients send null for an optional argument they leave out. */
const optionalInput = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const SessionState = Schema.Literals([
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "idle",
]);

/** The latest turn's timing, or null before the first turn starts. */
const TurnTimes = Schema.NullOr(
  Schema.Struct({ started_at: Schema.String, completed_at: Schema.NullOr(Schema.String) }),
);

const AgentSummary = Schema.Struct({
  agent: Schema.String,
  name: Schema.String,
  status: Schema.String,
  message: Schema.optional(Schema.String),
  default_model: Schema.NullOr(Schema.String),
  models: Schema.Array(Schema.Struct({ model: Schema.String, name: Schema.String })),
});

const ListProjectsResult = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      server_id: Schema.String,
      name: Schema.String,
      error: Schema.optional(Schema.String),
      warning: Schema.optional(Schema.String),
      agents: Schema.optional(Schema.Array(AgentSummary)),
    }),
  ),
  projects: Schema.Array(
    Schema.Struct({
      server_id: Schema.String,
      project_id: Schema.String,
      name: Schema.String,
      path: Schema.String,
      default_agent: Schema.optional(Schema.String),
      default_model: Schema.optional(Schema.String),
    }),
  ),
});

const ModelCapabilitiesResult = Schema.Struct({
  server_id: Schema.String,
  agent: Schema.String,
  model: Schema.String,
  name: Schema.String,
  reasoning_effort_support: Schema.Literals(["configurable", "not_configurable", "unknown"]),
  reasoning_efforts: Schema.Array(
    Schema.Struct({
      value: Schema.String,
      name: Schema.String,
      description: Schema.optional(Schema.String),
    }),
  ),
  default_reasoning_effort: Schema.NullOr(Schema.String),
});

const ListSessionsResult = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      server_id: Schema.String,
      name: Schema.String,
      error: Schema.optional(Schema.String),
    }),
  ),
  sessions: Schema.Array(
    Schema.Struct({
      server_id: Schema.String,
      session_id: Schema.String,
      project_id: Schema.String,
      project_name: Schema.String,
      title: Schema.String,
      agent: Schema.String,
      model: Schema.String,
      reasoning_effort: Schema.NullOr(Schema.String),
      state: SessionState,
      created_at: Schema.String,
      updated_at: Schema.String,
      turn: TurnTimes,
    }),
  ),
  more_sessions: Schema.Int,
});

const CreateSessionResult = Schema.Struct({
  server_id: Schema.String,
  session_id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  agent: Schema.String,
  model: Schema.String,
  reasoning_effort: Schema.NullOr(Schema.String),
  runtime_mode: Schema.String,
  state: Schema.Literal("queued"),
  branch: Schema.NullOr(Schema.String),
  worktree_path: Schema.NullOr(Schema.String),
});

const SendSessionMessageResult = Schema.Struct({
  server_id: Schema.String,
  session_id: Schema.String,
  title: Schema.String,
  agent: Schema.String,
  delivery: Schema.Literals(["new_turn", "during_turn", "steered", "queued"]),
  message_id: Schema.String,
  cursor: Schema.String,
});

const QueuedMessages = Schema.Array(
  Schema.Struct({
    message_id: Schema.String,
    state: Schema.Literals(["queued", "dispatching", "failed", "cancelled"]),
    error: Schema.optional(Schema.String),
  }),
);

const InterruptSessionResult = Schema.Struct({
  server_id: Schema.String,
  session_id: Schema.String,
  result: Schema.Literals(["interrupt_requested", "already_inactive", "turn_changed"]),
  state: SessionState,
  cancelled_message_ids: Schema.Array(Schema.String),
  cursor: Schema.String,
});

const SessionStatusResult = Schema.Struct({
  queued_messages: QueuedMessages,
  server_id: Schema.String,
  session_id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  agent: Schema.String,
  model: Schema.String,
  reasoning_effort: Schema.NullOr(Schema.String),
  state: SessionState,
  error: Schema.optional(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktree_path: Schema.NullOr(Schema.String),
  waiting_for: Schema.optional(
    Schema.Struct({
      approvals: Schema.Array(
        Schema.Struct({
          request_id: Schema.String,
          kind: Schema.String,
          detail: Schema.optional(Schema.String),
          app_name: Schema.optional(Schema.String),
          options: Schema.optional(Schema.Array(ProviderApprovalOption)),
        }),
      ),
      questions: Schema.Array(
        Schema.Struct({
          request_id: Schema.String,
          question_id: Schema.String,
          header: Schema.String,
          question: Schema.String,
          options: Schema.Array(Schema.String),
          choices: Schema.Array(
            Schema.Struct({
              label: Schema.String,
              description: Schema.String,
              value: Schema.String,
            }),
          ),
          multi_select: Schema.Boolean,
          allow_custom_answer: Schema.Boolean,
        }),
      ),
    }),
  ),
  turn: TurnTimes,
  changed_files: Schema.optional(
    Schema.Struct({
      count: Schema.Int,
      additions: Schema.Int,
      deletions: Schema.Int,
      files: Schema.Array(
        Schema.Struct({ path: Schema.String, additions: Schema.Int, deletions: Schema.Int }),
      ),
    }),
  ),
  updates: Schema.Array(
    Schema.Struct({
      at: Schema.String,
      type: Schema.Literals(["user_message", "assistant_message", "system_message", "activity"]),
      text: Schema.String,
      streaming: Schema.optional(Schema.Literal(true)),
      truncated: Schema.optional(Schema.Literal(true)),
    }),
  ),
  omitted_updates: Schema.Int,
  cursor: Schema.String,
});

const ListProjectsTool = Tool.make("list_projects", {
  description:
    "List the T3 Code projects a coding session can start in, across every configured T3 server, with the coding agents and models each server offers. Call this before create_project or create_session to get server_id and existing project_id values. To see a chosen model's reasoning effort levels, call get_model_capabilities. An unreachable server is reported with an error while the others still list.",
  parameters: Schema.Struct({
    server_id: optionalInput(TextInput("Only list this server_id.")),
  }),
  success: ListProjectsResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "List T3 Code projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const GetModelCapabilitiesTool = Tool.make("get_model_capabilities", {
  description:
    'Report what can be configured for one model on one server before starting a session with it: currently its reasoning effort, how hard the model thinks before answering. Call it after choosing an agent and model from list_projects. reasoning_effort_support is configurable when reasoning_efforts lists the values the model accepts, not_configurable when the model has no effort setting, and unknown when the server does not report the model\'s options; in the last two cases omit reasoning_effort from create_session. Pass a reasoning_efforts value unchanged as create_session\'s reasoning_effort, with the returned agent and model so it applies to the same model. default_reasoning_effort is what the model uses when none is requested, or null. agent and model accept the same ids and spoken names as create_session ("Claude", "opus").',
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    agent: optionalInput(
      TextInput("Agent id or name, e.g. codex or Claude. Omit to find the agent offering model."),
    ),
    model: TextInput("Model id or name from list_projects, e.g. gpt-6-astra or opus."),
  }),
  success: ModelCapabilitiesResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Inspect a model's options")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListSessionsTool = Tool.make("list_sessions", {
  description:
    "Find existing coding sessions (threads) on the configured T3 servers, most recently active first, including ones started in T3 Code itself. Use it to check on earlier work or to get the session_id for send_session_message and get_session_status. Filter by server_id, project_id, or words from the title. Archived sessions are not listed. An unreachable server is reported with an error while the others still list.",
  parameters: Schema.Struct({
    server_id: optionalInput(TextInput("Only list sessions on this server_id.")),
    project_id: optionalInput(TextInput("Only list sessions in this project_id.")),
    query: optionalInput(
      Schema.String.annotate({ description: "Words that must all appear in the title." }),
    ),
    limit: optionalInput(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
        description: `Most recently active sessions to return (default ${DEFAULT_SESSION_LIMIT}).`,
      }),
    ),
  }),
  success: ListSessionsResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Find T3 Code sessions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CreateProjectTool = Tool.make("create_project", {
  description:
    "Create/register a project on a selected T3 server. Use a local folder (created if missing), a Git clone URL, or a repository looked up through the server's configured source control provider. Paths belong to the selected server, not the MCP client. Clone destinations must be missing or empty. Repository lookup uses that server's credentials. Clones are awaited; success returns server_id and project_id ready for create_session. Duplicate active project paths are rejected. A failed or timed-out clone can leave a registered project; inspect it in T3 Code before retrying.",
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    source: Schema.Union([
      Schema.Struct({
        type: Schema.Literal("local"),
        path: TextInput("Folder on the selected server; absolute or ~/ path. Created if missing."),
      }),
      Schema.Struct({
        type: Schema.Literal("url"),
        remote_url: TextInput(
          "Git clone URL (HTTPS, SSH, or local Git path), or GitHub owner/repo shorthand.",
        ),
        destination_path: TextInput(
          "Full checkout folder on the selected server, not its parent; must be missing or empty.",
        ),
      }),
      Schema.Struct({
        type: Schema.Literals(["github", "gitlab", "forgejo", "bitbucket", "azure-devops"]),
        repository: TextInput(
          "Repository identifier accepted by the provider: owner/repo, group/project, workspace/repository, or Azure DevOps project/repository. Azure DevOps uses the server CLI's configured organization.",
        ),
        destination_path: TextInput(
          "Full checkout folder on the selected server; must be missing or empty.",
        ),
        protocol: optionalInput(
          SourceControlCloneProtocol.annotate({
            description:
              "Clone transport. Omitted uses HTTPS for GitHub/Forgejo and SSH for other providers, as in T3 Code. auto selects SSH.",
          }),
        ),
      }),
    ]),
  }),
  success: Schema.Struct({
    server_id: Schema.String,
    project_id: Schema.String,
    name: Schema.String,
    path: Schema.String,
  }),
  failure: BridgeError,
})
  .annotate(Tool.Title, "Create a T3 Code project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);
const CheckoutInput = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("local"),
    branch: optionalInput(
      TextInput(
        "Existing ref to switch to in the project checkout; omit to leave the checkout untouched.",
      ),
    ),
    create_branch: optionalInput(
      Schema.Boolean.annotate({
        description:
          "Create branch from the current checkout HEAD and switch to it. Requires branch. Default false.",
      }),
    ),
  }),
  Schema.Struct({
    mode: Schema.Literal("worktree"),
    base_branch: TextInput("Base branch/ref for T3's new worktree preparation. Required."),
    branch: optionalInput(
      TextInput(
        "New branch name; omit for T3's temporary worktree branch name. Existing names/conflicts are rejected by T3.",
      ),
    ),
    start_from_origin: optionalInput(
      Schema.Boolean.annotate({
        description:
          "Fetch origin and use its version of the base branch when available, falling back to local. Default false.",
      }),
    ),
    run_setup_script: optionalInput(
      Schema.Boolean.annotate({
        description:
          "Run the project's configured worktree setup actions. Default true. T3 controls path and submodules.",
      }),
    ),
  }),
  Schema.Struct({
    mode: Schema.Literal("existing_worktree"),
    branch: TextInput(
      "Local branch already checked out in a worktree of this project. T3 resolves and validates its path.",
    ),
  }),
]);

const CreateSessionTool = Tool.make("create_session", {
  description:
    "Start a coding agent on a project. T3 Code creates a new session (thread) and runs the agent in the selected checkout with the project's configured permission mode; the agent keeps working after this returns. Write task as a complete, self-contained instruction for the coding agent. Omit agent and model to use the project's default; otherwise pass values from list_projects (spoken names such as \"Claude\" or \"opus\" also match). Omit reasoning_effort to keep the project's or model's default; to choose one, pass a value from get_model_capabilities for the same agent and model. Values the selected model does not support are rejected before anything starts. Omit checkout for the existing default: use the project checkout untouched, even if project settings prefer worktrees. checkout selects local (optionally switch/create branch), worktree (new isolated worktree from required base_branch; requires a server advertising required-worktree support), or existing_worktree (reuse a checked-out branch). Local switching affects other sessions sharing that checkout and T3 rejects Git conflicts. Worktree preparation uses T3 setup, path allocation, submodule settings, and conflict handling; it can take minutes. A timeout can leave preparation running: inspect list_sessions before retrying. Follow progress with get_session_status, and continue the same session with send_session_message.",
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    project_id: TextInput("project_id from list_projects or create_project."),
    checkout: optionalInput(CheckoutInput),
    task: TextInput("The instruction for the coding agent, sent as the session's first message."),
    agent: optionalInput(TextInput("Agent id or name, e.g. codex or Claude.")),
    model: optionalInput(TextInput("Model id or name for that agent.")),
    reasoning_effort: optionalInput(
      TextInput(
        "A reasoning_efforts value from get_model_capabilities for the selected model, e.g. high.",
      ),
    ),
  }),
  success: CreateSessionResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Start a coding session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SendSessionMessageTool = Tool.make("send_session_message", {
  description:
    "Send a message to an existing session, preserving its history, agent, and model. mode steer is T3's Send now: dispatch immediately using the provider's existing mid-turn behavior (delivery steered), which may incorporate input, cancel/re-prompt, or run it next depending on the provider; it does not guarantee instantaneous redirection. mode queue is T3's Queue: hold in the bridge until the next completed tool call or the end of the turn, then dispatch through the same path; it can therefore enter the current turn before it ends. delivery queued means held for later delivery; get_session_status reports queued_messages, including failures. Queues are in memory, lost on bridge restart, and cancelled by interrupt_session. Either mode starts a new turn when idle, completed, interrupted, or failed (delivery new_turn). While waiting for approval or an answer, queue holds until the user responds through the response tools or in T3 Code; steer refuses. Omit mode (or pass null) to preserve legacy immediate sending with delivery during_turn or new_turn, refusing while waiting. Dispatch is asynchronous: delivery describes routing, not provider completion; follow progress with get_session_status and the returned cursor.",
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    session_id: SessionIdInput,
    message: TextInput("The message for the coding agent, as the user would type it in T3 Code."),
    mode: optionalInput(
      Schema.Literals(["queue", "steer"]).annotate({
        description:
          "queue waits for a tool-completion/turn-end boundary; steer sends now. Omit for legacy immediate behavior.",
      }),
    ),
  }),
  success: SendSessionMessageResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Message a coding session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const InterruptSessionTool = Tool.make("interrupt_session", {
  description:
    "Request T3 Code's Stop action for a running session, including one waiting for approval or input. Interrupts provider execution through the same command as the UI, retaining the thread and history so send_session_message can resume later. Provider-specific cancellation governs tool calls/subprocesses; some providers close their runtime and reopen on the next message. Cancels this bridge's queued messages for the session. Queued/starting sessions cannot yet be stopped with the composer's Stop action and return interrupt_not_applicable; retry after the provider is running. Inactive sessions (or a turn that finished before dispatch) return already_inactive. If a different active turn is observed before dispatch, turn_changed leaves it running. interrupt_requested confirms command acceptance, not that the provider has stopped; state is the observed state after acceptance, which may still be running/waiting. Use get_session_status to confirm settlement or see provider errors. Concurrent activity follows the UI's session-level Stop semantics.",
  parameters: Schema.Struct({ server_id: ServerIdInput, session_id: SessionIdInput }),
  success: InterruptSessionResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Stop a coding session's work")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const GetSessionStatusTool = Tool.make("get_session_status", {
  description:
    "Report queued_messages held by this bridge (and their delivery failures/cancellations) and how a coding session is going: its state, what the agent recently said and did, and the files its latest turn changed. state is queued, starting, running, waiting (the agent needs an approval or an answer, use answer_session_question or respond_to_session_approval only after obtaining the user’s response), completed, interrupted, failed, or idle. Pass the cursor from the previous call to receive only newer updates.",
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    session_id: SessionIdInput,
    cursor: optionalInput(
      Schema.String.annotate({ description: "cursor from the previous get_session_status call." }),
    ),
    limit: optionalInput(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
        description: `Most recent updates to return (default ${DEFAULT_UPDATE_LIMIT}).`,
      }),
    ),
  }),
  success: SessionStatusResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Check a coding session")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RequestResponseResult = Schema.Struct({
  server_id: Schema.String,
  session_id: Schema.String,
  request_id: Schema.String,
  accepted: Schema.Literal(true),
  cursor: Schema.String,
});

const AnswerSessionQuestionTool = Tool.make("answer_session_question", {
  description:
    "Answer one pending agent request. First call get_session_status and present its actual questions and choices to the user. Obtain the user's response, then submit exactly that response; never choose for them. request_id identifies the request, which may contain several questions: answers must include every question_id in that request, with no extras. Each answer is a string (exact choice value, or free-form text only when allow_custom_answer is true) or an array of exact choice values for multi_select questions. choices contain labels, descriptions, and the actual values; options is the legacy label list. IDs and values are opaque: preserve whitespace. Stale requests, missing questions, invalid choices, and unsupported custom answers are rejected. Returns accepted plus a cursor for get_session_status; acceptance queues T3's existing response flow, and subsequent status can report provider errors or other pending requests.",
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    session_id: SessionIdInput,
    request_id: TextInput("request_id from waiting_for.questions in get_session_status."),
    answers: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    ).annotate({
      description:
        "All question_id keys for this request mapped to the user's exact answer or selected choice values.",
    }),
  }),
  success: RequestResponseResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Answer an agent question")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const RespondToSessionApprovalTool = Tool.make("respond_to_session_approval", {
  description:
    "Submit the user's explicit decision on one pending agent approval. First inspect waiting_for.approvals in get_session_status and explain the complete request detail, application, available options, and warnings to the user. Explicitly ask for approval or denial; only call this after receiving their decision. Never automatically approve. Use accept for one approval or decline to deny; cancel cancels the request. acceptForSession and acceptAlways broaden permission and require explicit user agreement to that scope and an offered option. When options are present use an offered decision only; otherwise T3's default choices are accept, decline, cancel, and acceptForSession. Stale requests and unavailable decisions are rejected. This uses T3's normal authorization and provider approval path. Returns accepted plus a cursor to monitor get_session_status; provider failures can appear asynchronously.",
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    session_id: SessionIdInput,
    request_id: TextInput("request_id from waiting_for.approvals in get_session_status."),
    decision: ProviderApprovalDecision.annotate({
      description: "The user's explicit decision, with exactly the permission scope they approved.",
    }),
  }),
  success: RequestResponseResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Respond to an agent approval")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const BridgeToolkit = Toolkit.make(
  ListProjectsTool,
  GetModelCapabilitiesTool,
  GetUsageTool,
  ListSessionsTool,
  CreateProjectTool,
  CreateSessionTool,
  SendSessionMessageTool,
  InterruptSessionTool,
  GetSessionStatusTool,
  AnswerSessionQuestionTool,
  RespondToSessionApprovalTool,
);

/** The placeholder title a new thread shows until the server generates one. */
const sessionTitle = (task: string) => {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
};

const make = Effect.gen(function* () {
  const environments = yield* Environments;
  const messageQueue = yield* makeMessageQueue;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const targets = (serverId: string | null | undefined) =>
    serverId == null
      ? environments.enabled
      : environments.get(serverId).pipe(Effect.map((environment) => [environment]));

  return BridgeToolkit.of({
    get_usage: (input) => getUsage(environments, input),
    list_projects: ({ server_id }) =>
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const listings = yield* Effect.forEach(
          yield* targets(server_id),
          (environment) =>
            Effect.all(
              [Effect.result(environment.shell), Effect.result(environment.serverConfig)],
              {
                concurrency: 2,
              },
            ).pipe(
              Effect.map(([shell, config]) => {
                const remainingMs = Date.parse(environment.expiresAt) - nowMs;
                const server = {
                  server_id: environment.id,
                  name: environment.name,
                  ...(remainingMs < TOKEN_WARNING_MS
                    ? {
                        warning: `The bridge's token for this server expires ${remainingMs < 86_400_000 ? "within a day" : `in ${Math.floor(remainingMs / 86_400_000)} days`}. Re-pair it on the bridge admin page.`,
                      }
                    : {}),
                };
                if (Result.isFailure(shell)) {
                  return { server: { ...server, error: shell.failure.message }, projects: [] };
                }
                const projects = shell.success.projects.map((project) => {
                  const listed = {
                    server_id: environment.id,
                    project_id: project.id,
                    name: project.title,
                    path: project.workspaceRoot,
                  };
                  if (Result.isFailure(config)) return listed;
                  const selection = resolveModelSelection({
                    providers: config.success.providers,
                    projectDefault: resolveProjectSettings(
                      config.success.settings,
                      project.id,
                      project,
                    ).settings.defaultModelSelection,
                  });
                  return Result.isFailure(selection)
                    ? listed
                    : {
                        ...listed,
                        default_agent: selection.success.instanceId,
                        default_model: selection.success.model,
                      };
                });
                return {
                  server: Result.isFailure(config)
                    ? { ...server, error: `Agents unavailable: ${config.failure.message}` }
                    : { ...server, agents: summarizeAgents(config.success.providers) },
                  projects,
                };
              }),
            ),
          { concurrency: "unbounded" },
        );
        return {
          servers: listings.map((listing) => listing.server),
          projects: listings.flatMap((listing) => listing.projects),
        };
      }),

    get_model_capabilities: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const config = yield* environment.serverConfig;
        const described = describeModelCapabilities({
          providers: config.providers,
          agent: input.agent ?? undefined,
          model: input.model,
        });
        if (Result.isFailure(described)) {
          return yield* new BridgeError({ message: described.failure });
        }
        return { server_id: environment.id, ...described.success };
      }),

    list_sessions: (input) =>
      Effect.gen(function* () {
        const shells = yield* Effect.forEach(
          yield* targets(input.server_id),
          (environment) =>
            Effect.result(environment.shell).pipe(Effect.map((shell) => ({ environment, shell }))),
          { concurrency: "unbounded" },
        );
        return {
          servers: shells.map(({ environment, shell }) => ({
            server_id: environment.id,
            name: environment.name,
            ...(Result.isFailure(shell) ? { error: shell.failure.message } : {}),
          })),
          ...findSessions(
            shells.flatMap(({ environment, shell }) =>
              Result.isSuccess(shell) ? [{ serverId: environment.id, shell: shell.success }] : [],
            ),
            {
              projectId: input.project_id ?? undefined,
              query: input.query ?? undefined,
              limit: input.limit ?? DEFAULT_SESSION_LIMIT,
              now: yield* now,
            },
          ),
        };
      }),

    create_project: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const config = yield* environment.serverConfig;
        const resolved = resolveAddProjectPath({
          rawPath:
            input.source.type === "local" ? input.source.path : input.source.destination_path,
          platform: config.environment.platform.os,
        });
        if (!resolved.ok) return yield* new BridgeError({ message: resolved.error });
        const projectId = ProjectId.make(yield* uuid);
        const createdAt = yield* now;
        const source = input.source;
        if (source.type === "local") {
          yield* environment.createProject(
            buildProjectCreateCommand({
              commandId: CommandId.make(yield* uuid),
              projectId,
              workspaceRoot: resolved.path,
              createdAt,
            }),
          );
        } else {
          yield* environment.cloneProject({
            projectId,
            title: inferProjectTitleFromPath(resolved.path),
            createdAt,
            destinationPath: resolved.path,
            ...(source.type === "url"
              ? { remoteUrl: normalizePastedCloneUrl(source.remote_url) }
              : {
                  provider: source.type,
                  repository: source.repository,
                  protocol:
                    source.protocol ??
                    (source.type === "github" || source.type === "forgejo" ? "https" : "ssh"),
                }),
          });
        }
        const shell = yield* environment.shell;
        const project = shell.projects.find((candidate) => candidate.id === projectId);
        if (project === undefined) {
          return yield* new BridgeError({
            message: `Project ${projectId} was created on server "${environment.id}" but is no longer available. Call list_projects for current ids.`,
          });
        }
        return {
          server_id: environment.id,
          project_id: project.id,
          name: project.title,
          path: project.workspaceRoot,
        };
      }),

    create_session: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const [shell, config] = yield* Effect.all([environment.shell, environment.serverConfig], {
          concurrency: 2,
        });
        const project = shell.projects.find((candidate) => candidate.id === input.project_id);
        if (project === undefined) {
          return yield* new BridgeError({
            message: `Project ${input.project_id} was not found on server "${environment.id}". Call list_projects for current ids.`,
          });
        }
        const settings = resolveProjectSettings(config.settings, project.id, project).settings;
        const selection = resolveModelSelection({
          providers: config.providers,
          projectDefault: settings.defaultModelSelection,
          agent: input.agent ?? undefined,
          model: input.model ?? undefined,
        });
        if (Result.isFailure(selection)) {
          return yield* new BridgeError({ message: selection.failure });
        }
        const reasoningEffort = input.reasoning_effort;
        const withEffort =
          reasoningEffort == null
            ? selection
            : applyReasoningEffort({
                providers: config.providers,
                selection: selection.success,
                reasoningEffort,
              });
        if (Result.isFailure(withEffort)) {
          return yield* new BridgeError({ message: withEffort.failure });
        }
        const modelSelection = withEffort.success;
        const runtimeMode = settings.defaultRuntimeMode;
        const interactionMode = DEFAULT_PROVIDER_INTERACTION_MODE;
        const threadId = ThreadId.make(yield* uuid);
        const title = sessionTitle(input.task);
        const createdAt = yield* now;
        const checkout = input.checkout;
        let branch: string | null = null;
        let worktreePath: string | null = null;
        if (
          checkout?.mode === "worktree" &&
          config.environment.capabilities.requiredWorktreeBootstrap !== true
        ) {
          return yield* new BridgeError({
            message:
              "This server cannot guarantee an isolated worktree. Update T3 Code before using checkout.mode worktree.",
          });
        }
        if (checkout?.mode === "local") {
          if (checkout.create_branch && !checkout.branch) {
            return yield* new BridgeError({
              message: "checkout.create_branch requires checkout.branch.",
            });
          }
          if (checkout.branch) {
            const result = checkout.create_branch
              ? yield* environment.createRef({
                  cwd: project.workspaceRoot,
                  refName: checkout.branch,
                  switchRef: true,
                })
              : yield* environment.switchRef({
                  cwd: project.workspaceRoot,
                  refName: checkout.branch,
                });
            branch = result.refName ?? checkout.branch;
          }
        } else if (checkout?.mode === "existing_worktree") {
          let cursor: number | undefined;
          let found = false;
          do {
            const refs = yield* environment.listRefs({
              cwd: project.workspaceRoot,
              query: checkout.branch,
              refKind: "local",
              refresh: true,
              ...(cursor === undefined ? {} : { cursor }),
            });
            const ref = refs.refs.find(
              (candidate) =>
                candidate.name === checkout.branch &&
                !candidate.isRemote &&
                candidate.worktreePath !== null,
            );
            if (ref) {
              found = true;
              branch = ref.name;
              worktreePath = ref.worktreePath === project.workspaceRoot ? null : ref.worktreePath;
              break;
            }
            cursor = refs.nextCursor ?? undefined;
          } while (cursor !== undefined);
          if (!found)
            return yield* new BridgeError({
              message: `Branch "${checkout.branch}" has no existing worktree in this project.`,
            });
        } else if (checkout?.mode === "worktree") {
          branch = checkout.branch ?? buildTemporaryWorktreeBranchName(() => threadId);
        }
        yield* environment.startTurn({
          type: "thread.turn.start",
          commandId: CommandId.make(yield* uuid),
          threadId,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text: input.task,
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode,
          bootstrap: {
            ...(checkout?.mode === "worktree"
              ? {
                  prepareWorktree: {
                    projectCwd: project.workspaceRoot,
                    baseBranch: checkout.base_branch,
                    branch: branch!,
                    startFromOrigin: checkout.start_from_origin ?? false,
                    requireWorktree: true,
                  },
                  runSetupScript: checkout.run_setup_script ?? true,
                }
              : {}),
            createThread: {
              projectId: project.id,
              title,
              modelSelection,
              runtimeMode,
              interactionMode,
              branch: checkout?.mode === "worktree" ? checkout.base_branch : branch,
              worktreePath,
              createdAt,
            },
          },
          createdAt,
        });
        const preparedThread =
          checkout?.mode === "worktree" ? (yield* environment.thread(threadId)).thread : null;
        yield* Effect.logInfo("created session", {
          server: environment.id,
          project: project.id,
          session: threadId,
          agent: modelSelection.instanceId,
          model: modelSelection.model,
          reasoningEffort: selectedReasoningEffort(modelSelection),
          runtimeMode,
        });
        return {
          server_id: environment.id,
          session_id: threadId,
          project_id: project.id,
          title,
          agent: modelSelection.instanceId,
          model: modelSelection.model,
          reasoning_effort: selectedReasoningEffort(modelSelection),
          runtime_mode: runtimeMode,
          branch: preparedThread?.branch ?? branch,
          worktree_path: preparedThread?.worktreePath ?? worktreePath,
          state: "queued" as const,
        };
      }),

    send_session_message: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const { thread } = yield* environment.thread(ThreadId.make(input.session_id));
        const createdAt = yield* now;
        const state = threadState(thread, createdAt);
        // A message would sit behind the request, or cancel it on agents
        // that steer by re-prompting.
        if (state === "waiting" && input.mode !== "queue") {
          return yield* new BridgeError({
            code: "message_not_applicable",
            state,
            message: `Session ${thread.id} is waiting for an approval or an answer, use answer_session_question or respond_to_session_approval only after obtaining the user’s response. The message was not sent. Call get_session_status to see what the agent is asking.`,
          });
        }
        // No bootstrap and no model selection: the server continues this thread
        // with its own agent, model, and provider session.
        const command = {
          type: "thread.turn.start" as const,
          commandId: CommandId.make(yield* uuid),
          threadId: thread.id,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user" as const,
            text: input.message,
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt,
        };
        const active =
          state === "queued" || state === "starting" || state === "running" || state === "waiting";
        const queued =
          input.mode === "queue" &&
          (active ||
            messageQueue
              .list(environment.id, thread.id)
              .some((entry) => entry.state === "queued" || entry.state === "dispatching"));
        if (queued) yield* messageQueue.enqueue(environment, thread, command);
        else yield* environment.startTurn(command);
        const delivery = queued
          ? ("queued" as const)
          : !active
            ? ("new_turn" as const)
            : input.mode === "steer"
              ? ("steered" as const)
              : ("during_turn" as const);
        yield* Effect.logInfo("sent message", {
          server: environment.id,
          session: thread.id,
          delivery,
        });
        return {
          server_id: environment.id,
          session_id: thread.id,
          title: thread.title,
          agent: thread.modelSelection.instanceId,
          delivery,
          message_id: command.message.messageId,
          // Taken before the send, so the next status includes the message and all that follows.
          cursor: latestCursor(thread),
        };
      }),

    interrupt_session: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const threadId = ThreadId.make(input.session_id);
        let { thread } = yield* environment.thread(threadId);
        let state = threadState(thread, yield* now);
        if (state === "queued" || state === "starting") {
          return yield* new BridgeError({
            code: "interrupt_not_applicable",
            state,
            message:
              "The provider is not running yet. T3's composer Stop action is not available until startup finishes. Call get_session_status and retry when running or waiting.",
          });
        }
        const observedTurnId = thread.session?.activeTurnId;
        const observedSessionStatus = thread.session?.status;
        const cancelled = yield* messageQueue.cancel(environment.id, thread.id);
        // Re-read after cancelling the outbox: completion during this step must
        // not be reported as a successful interruption.
        ({ thread } = yield* environment.thread(threadId));
        state = threadState(thread, yield* now);
        let result: "interrupt_requested" | "already_inactive" | "turn_changed" =
          "already_inactive";
        if (
          thread.session?.status === "running" &&
          (observedSessionStatus !== "running" || thread.session.activeTurnId !== observedTurnId)
        ) {
          result = "turn_changed";
        } else if (thread.session?.status === "running") {
          yield* environment.interruptTurn({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(yield* uuid),
            threadId,
            ...(thread.session.activeTurnId === null
              ? {}
              : { turnId: thread.session.activeTurnId }),
            createdAt: yield* now,
          });
          result = "interrupt_requested";
          ({ thread } = yield* environment.thread(threadId));
          state = threadState(thread, yield* now);
        } else if (
          state === "running" ||
          state === "waiting" ||
          state === "starting" ||
          state === "queued"
        ) {
          return yield* new BridgeError({
            code: "interrupt_not_applicable",
            state,
            message:
              "No running provider session is bound to this thread. Call get_session_status before retrying Stop.",
          });
        }
        return {
          server_id: environment.id,
          session_id: thread.id,
          result,
          state,
          cancelled_message_ids: cancelled,
          cursor: latestCursor(thread),
        };
      }),

    answer_session_question: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const { thread } = yield* environment.thread(ThreadId.make(input.session_id));
        const request = derivePendingRequests(thread.activities).userInputs.find(
          (request) => request.requestId === input.request_id,
        );
        if (!request)
          return yield* new BridgeError({
            message:
              "This question request is no longer pending. Call get_session_status for current requests.",
          });
        if (
          Object.keys(input.answers).length !== request.questions.length ||
          Object.keys(input.answers).some(
            (id) => !request.questions.some((question) => question.id === id),
          )
        ) {
          return yield* new BridgeError({
            message: "Answer every question_id in this request, with no extra IDs.",
          });
        }
        for (const question of request.questions) {
          const answer = input.answers[question.id];
          const values = new Set(question.options.map((option) => option.value ?? option.label));
          const valid =
            typeof answer === "string"
              ? values.has(answer) ||
                (question.allowCustomAnswer !== false && answer.trim().length > 0)
              : Array.isArray(answer) &&
                question.multiSelect === true &&
                answer.length > 0 &&
                new Set(answer).size === answer.length &&
                answer.every((value) => values.has(value));
          if (!valid)
            return yield* new BridgeError({
              message: `Invalid answer for question_id "${question.id}". Use its choices and custom/multi-select constraints from get_session_status.`,
            });
        }
        yield* environment.dispatchCommand({
          type: "thread.user-input.respond",
          commandId: CommandId.make(yield* uuid),
          threadId: thread.id,
          requestId: ApprovalRequestId.make(input.request_id),
          answers: input.answers,
          createdAt: yield* now,
        });
        return {
          server_id: environment.id,
          session_id: thread.id,
          request_id: input.request_id,
          accepted: true as const,
          cursor: latestCursor(thread),
        };
      }),

    respond_to_session_approval: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const { thread } = yield* environment.thread(ThreadId.make(input.session_id));
        const request = derivePendingRequests(thread.activities).approvals.find(
          (request) => request.requestId === input.request_id,
        );
        if (!request)
          return yield* new BridgeError({
            message:
              "This approval request is no longer pending. Call get_session_status for current requests.",
          });
        const decisions = request.options?.map((option) => option.decision) ?? [
          "accept",
          "decline",
          "cancel",
          "acceptForSession",
        ];
        if (!decisions.includes(input.decision))
          return yield* new BridgeError({
            message: "This decision is not offered for the pending approval.",
          });
        yield* environment.dispatchCommand({
          type: "thread.approval.respond",
          commandId: CommandId.make(yield* uuid),
          threadId: thread.id,
          requestId: ApprovalRequestId.make(input.request_id),
          decision: input.decision,
          createdAt: yield* now,
        });
        return {
          server_id: environment.id,
          session_id: thread.id,
          request_id: input.request_id,
          accepted: true as const,
          cursor: latestCursor(thread),
        };
      }),

    get_session_status: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const { thread } = yield* environment.thread(ThreadId.make(input.session_id));
        return {
          server_id: environment.id,
          session_id: thread.id,
          project_id: thread.projectId,
          title: thread.title,
          agent: thread.modelSelection.instanceId,
          model: thread.modelSelection.model,
          reasoning_effort: selectedReasoningEffort(thread.modelSelection),
          queued_messages: messageQueue.list(environment.id, thread.id),
          branch: thread.branch,
          worktree_path: thread.worktreePath,
          ...summarizeSession(thread, {
            cursor: input.cursor ?? undefined,
            limit: input.limit ?? DEFAULT_UPDATE_LIMIT,
            now: yield* now,
          }),
        };
      }),
  });
});

export const BridgeToolkitHandlersLive = BridgeToolkit.toLayer(make);
