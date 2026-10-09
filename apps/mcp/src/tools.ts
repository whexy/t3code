import {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  RuntimeRequestId,
  SourceControlCloneProtocol,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  buildProjectCreateCommand,
  normalizePastedCloneUrl,
  resolveAddProjectPath,
} from "@t3tools/client-runtime/operations/projects";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import {
  applyReasoningEffort,
  resolveModelSelection,
  selectedReasoningEffort,
  summarizeAgents,
} from "./agents.ts";
import { BridgeError, Environments } from "./environment.ts";
import { InspectProjectTool, inspectProject } from "./inspect.ts";
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
  models: Schema.Array(
    Schema.Struct({
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
    }),
  ),
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

/** The thread's queue: waiting runs after the active turn; held waits for resume_queue. */
const QueuedMessages = Schema.Array(
  Schema.Struct({ message_id: Schema.String, state: Schema.Literals(["waiting", "held"]) }),
);

const ControlSessionResult = Schema.Struct({
  server_id: Schema.String,
  session_id: Schema.String,
  result: Schema.Literals([
    "stop_requested",
    "already_inactive",
    "queue_resumed",
    "nothing_held",
    "dropped",
  ]),
  dropped_message_ids: Schema.Array(Schema.String),
  state: SessionState,
  queued_messages: QueuedMessages,
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
    "List the T3 Code projects a coding session can start in, across every configured T3 server, with the coding agents and models each server offers. Call this before create_project or create_session to get server_id and existing project_id values. For one project's repository, branches, worktrees, and settings on every server, call inspect_project. Each model reports its reasoning effort, how hard it thinks before answering: reasoning_effort_support is configurable when reasoning_efforts lists the values the model accepts, not_configurable when the model has no effort setting, and unknown when the server does not report the model's options; in the last two cases omit reasoning_effort from create_session. Pass a reasoning_efforts value unchanged as create_session's reasoning_effort, with that agent and model. default_reasoning_effort is what the model uses when none is requested, or null. An unreachable server is reported with an error while the others still list.",
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
    "Create/register a project on a selected T3 server. Use a local folder (created if missing), a Git clone URL, or a repository looked up through the server's configured source control provider. Paths belong to the selected server, not the MCP client. Clone destinations must be missing or empty. Repository lookup uses that server's credentials. Clones are awaited; success returns server_id and project_id ready for create_session. Duplicate active project paths are rejected. A failure's state says what exists: not_created means nothing was registered, so fix the input and retry; registered means the project exists but its clone failed, was cancelled, or is unconfirmed; unknown means the server did not answer, so call list_projects before retrying.",
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
    "Start a coding agent on a project. T3 Code creates a new session (thread) and runs the agent in the selected checkout with the project's configured permission mode; the agent keeps working after this returns. Write task as a complete, self-contained instruction for the coding agent. Omit agent and model to use the project's default; otherwise pass values from list_projects (spoken names such as \"Claude\" or \"opus\" also match). Omit reasoning_effort to keep the project's or model's default; to choose one, pass a reasoning_efforts value that list_projects reports for the same agent and model. Values the selected model does not support are rejected before anything starts. Omit checkout for the existing default: use the project checkout untouched, even if project settings prefer worktrees. checkout selects local (optionally switch/create branch), worktree (new isolated worktree from required base_branch), or existing_worktree (reuse a checked-out branch). Local switching affects other sessions sharing that checkout and T3 rejects Git conflicts. Worktree preparation uses T3 setup, path allocation, submodule settings, and conflict handling; it can take minutes. A timeout can leave preparation running: inspect list_sessions before retrying. Follow progress with get_session_status, and continue the same session with send_session_message.",
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    project_id: TextInput("project_id from list_projects or create_project."),
    checkout: optionalInput(CheckoutInput),
    task: TextInput("The instruction for the coding agent, sent as the session's first message."),
    agent: optionalInput(TextInput("Agent id or name, e.g. codex or Claude.")),
    model: optionalInput(TextInput("Model id or name for that agent.")),
    reasoning_effort: optionalInput(
      TextInput(
        "A reasoning_efforts value list_projects reports for the selected model, e.g. high.",
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
    "Send a message to an existing session, preserving its history, agent, and model. mode steer is T3's Send now: steer the active turn using the provider's mid-turn behavior (delivery steered), which may incorporate input in place or interrupt and restart the turn with it; the server rejects it while the turn is still starting or when the provider cannot steer. mode queue is T3's Queue: T3 holds the message and runs it as the next turn once the active turn ends (delivery queued); it never enters the current turn. Queued messages wait on the server, survive bridge restarts, appear in T3 Code, and are listed in get_session_status queued_messages along with those queued there. Either mode starts a new turn when idle, completed, interrupted, or failed (delivery new_turn). While waiting for approval or an answer, queue waits for the turn to end; steer refuses. Omit mode (or pass null) for T3's default send: steer the active turn when the provider can (delivery during_turn), otherwise queue it (delivery queued), refusing while waiting. Dispatch is asynchronous: delivery describes routing, not provider completion; follow progress with get_session_status and the returned cursor.",
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    session_id: SessionIdInput,
    message: TextInput("The message for the coding agent, as the user would type it in T3 Code."),
    mode: optionalInput(
      Schema.Literals(["queue", "steer"]).annotate({
        description:
          "queue runs after the active turn; steer redirects it now. Omit for T3's default send.",
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

const ControlSessionTool = Tool.make("control_session", {
  description:
    "Control a session's work and queue as T3 Code's UI does. action stop is T3's Stop for a starting or running session, including one waiting for approval or input: it interrupts the active run through the same command as the UI and keeps the thread and history, so send_session_message can resume later. Provider-specific cancellation governs tool calls and subprocesses. Like the UI's Stop, it holds queued messages rather than starting them next. result stop_requested confirms command acceptance, not that the provider has stopped; already_inactive means no work was running. action resume_queue releases held queued messages so they run in order once the session is idle (result queue_resumed), or reports nothing_held. action drop_queued deletes queued messages: every queued message on the thread when message_ids is omitted, otherwise exactly those listed. message_ids must all be queued messages from queued_messages; any other id (unknown, already started, or already dropped) fails the whole call and nothing is dropped. Dropping requires the user's explicit request. The result lists dropped_message_ids, the observed state, the updated queued_messages with each one waiting (runs after the active turn) or held (waits for resume_queue), and a cursor for get_session_status.",
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    session_id: SessionIdInput,
    action: Schema.Literals(["stop", "resume_queue", "drop_queued"]).annotate({
      description:
        "stop interrupts the active run and holds the queue; resume_queue releases a held queue; drop_queued deletes queued messages.",
    }),
    message_ids: optionalInput(
      Schema.Array(TextInput("message_id from queued_messages.")).annotate({
        description:
          "Only for drop_queued: the queued messages to delete. Omit to delete every queued message.",
      }),
    ),
  }),
  success: ControlSessionResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Control a coding session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const GetSessionStatusTool = Tool.make("get_session_status", {
  description:
    "Report queued_messages, every message on the thread still waiting for its turn (from this bridge or T3 Code), each with state waiting (runs after the active turn) or held (held by a stop; release it with control_session resume_queue), and how a coding session is going: its state, what the agent recently said and did, and the files its latest turn changed. state is queued, starting, running, waiting (the agent needs an approval or an answer: waiting_for lists them; show the user the actual question or approval, get their explicit response, then submit it with respond_to_session), completed, interrupted, failed, or idle. Pass the cursor from the previous call to receive only newer updates.",
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

const RespondToSessionTool = Tool.make("respond_to_session", {
  description:
    "Submit the user's response to one pending agent request from waiting_for in get_session_status: answers for a question request, or decision for an approval. Pass exactly one of them; the wrong kind for the request is rejected. First show the user the actual request and get their explicit response; never choose or approve for them. Questions: present the questions and choices, then submit exactly what the user answered. A request may contain several questions: answers must include every question_id in it, with no extras. Each answer is a string (exact choice value, or free-form text only when allow_custom_answer is true) or an array of exact choice values for multi_select questions. choices contain labels, descriptions, and the actual values; options is the legacy label list. IDs and values are opaque: preserve whitespace. Approvals: explain the complete request detail, application, available options, and warnings, and ask explicitly for approval or denial. Use accept for one approval or decline to deny; cancel cancels the request. acceptForSession and acceptAlways broaden permission and require explicit user agreement to that scope and an offered option. When options are present use an offered decision only; otherwise T3's default choices are accept, decline, cancel, and acceptForSession. Stale requests, missing questions, invalid choices, unsupported custom answers, and unavailable decisions are rejected. This uses T3's normal authorization and response path. Returns accepted plus a cursor for get_session_status; provider errors or other pending requests can appear asynchronously.",
  parameters: Schema.Struct({
    server_id: ServerIdInput,
    session_id: SessionIdInput,
    request_id: TextInput("request_id from waiting_for in get_session_status."),
    answers: optionalInput(
      Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Array(Schema.String)]),
      ).annotate({
        description:
          "For a question request only: all question_id keys mapped to the user's exact answer or selected choice values.",
      }),
    ),
    decision: optionalInput(
      ProviderApprovalDecision.annotate({
        description:
          "For an approval only: the user's explicit decision, with exactly the permission scope they approved.",
      }),
    ),
  }),
  success: RequestResponseResult,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Respond to an agent request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const BridgeToolkit = Toolkit.make(
  ListProjectsTool,
  InspectProjectTool,
  GetUsageTool,
  ListSessionsTool,
  CreateProjectTool,
  CreateSessionTool,
  SendSessionMessageTool,
  ControlSessionTool,
  GetSessionStatusTool,
  RespondToSessionTool,
);

/** The placeholder title a new thread shows until the server generates one. */
const sessionTitle = (task: string) => {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
};

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/**
 * The run T3 Code's Stop interrupts: the newest active one, else a settled
 * run whose background work still holds the thread.
 */
function interruptibleRunId(projection: OrchestrationV2ThreadProjection) {
  const active = projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status));
  if (active !== undefined) return active.id;
  const latestRun = projection.runs.at(-1);
  const backgroundWork = derivePendingBackgroundWork({
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs: projection.runs,
  });
  return backgroundWork.length > 0 ? latestRun?.id : undefined;
}

/** Messages waiting on the thread's queue, whether held after a Stop or due after the active run. */
const queuedRuns = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.filter((run) => run.status === "queued");

/** What get_session_status and control_session report as queued_messages. */
const queuedMessages = (projection: OrchestrationV2ThreadProjection): typeof QueuedMessages.Type =>
  queuedRuns(projection).map((run) => ({
    message_id: run.userMessageId,
    state: run.queueHeld === true ? "held" : "waiting",
  }));

const make = Effect.gen(function* () {
  const environments = yield* Environments;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = uuid.pipe(Effect.map(CommandId.make));
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const targets = (serverId: string | null | undefined) =>
    serverId == null
      ? environments.enabled
      : environments.get(serverId).pipe(Effect.map((environment) => [environment]));

  return BridgeToolkit.of({
    get_usage: (input) => getUsage(environments, input),
    inspect_project: (input) => inspectProject(environments, input),
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
        const source = input.source;
        if (source.type === "local") {
          yield* environment.createProject(
            buildProjectCreateCommand({
              commandId: yield* commandId,
              projectId,
              workspaceRoot: resolved.path,
            }),
          );
        } else {
          yield* environment.cloneProject({
            projectId,
            title: inferProjectTitleFromPath(resolved.path),
            createdAt: yield* now,
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
        const checkout = input.checkout;
        let branch: string | null = null;
        let worktreePath: string | null = null;
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
        }
        const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
          checkout?.mode === "worktree"
            ? {
                type: "worktree",
                baseRef: checkout.base_branch,
                ...(checkout.branch == null ? {} : { branch: checkout.branch }),
                startFromOrigin: checkout.start_from_origin ?? false,
              }
            : worktreePath !== null
              ? { type: "existing_worktree", worktreePath, ...(branch === null ? {} : { branch }) }
              : { type: "root", ...(branch === null ? {} : { branch }) };
        const messageId = MessageId.make(yield* uuid);
        const launched = yield* environment.launchThread({
          commandId: yield* commandId,
          creationSource: "mcp",
          threadId,
          projectId: project.id,
          title,
          generateTitle: true,
          modelSelection,
          runtimeMode,
          interactionMode,
          workspaceStrategy,
          initialMessage: { messageId, text: input.task, attachments: [] },
        });
        const runId = launched.runs.find((run) => run.userMessageId === messageId)?.id;
        // The server prepares a new worktree after launch returns. The run
        // leaves preparation once the checkout and its setup are done or failed.
        const prepared =
          checkout?.mode === "worktree" && runId !== undefined
            ? yield* environment.waitForThread(
                threadId,
                (projection) =>
                  projection.thread.deletedAt !== null ||
                  projection.runs.some((run) => run.id === runId && run.status !== "preparing"),
              )
            : launched;
        if (prepared.thread.deletedAt !== null) {
          return yield* new BridgeError({
            message: `Session ${threadId} was deleted before its worktree was ready.`,
          });
        }
        if (prepared.runs.some((run) => run.id === runId && run.status === "failed")) {
          const failure = prepared.turnItems.findLast(
            (item) => item.type === "error" && item.runId === runId,
          );
          return yield* new BridgeError({
            message: `T3 server "${environment.id}" could not prepare the worktree${failure?.type === "error" ? `: ${failure.failure.message}` : "."} Session ${threadId} keeps the task; retry its preparation in T3 Code or start another session.`,
          });
        }
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
          branch: prepared.thread.branch ?? branch,
          worktree_path: prepared.thread.worktreePath,
          state: "queued" as const,
        };
      }),

    send_session_message: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const projection = yield* environment.thread(ThreadId.make(input.session_id));
        const thread = projection.thread;
        const state = threadState(projection);
        // A message would sit behind the request, or cancel it on agents
        // that steer by restarting the turn.
        if (state === "waiting" && input.mode !== "queue") {
          return yield* new BridgeError({
            code: "message_not_applicable",
            state,
            message: `Session ${thread.id} is waiting for an approval or an answer, answer it with respond_to_session only after obtaining the user’s response. The message was not sent. Call get_session_status to see what the agent is asking.`,
          });
        }
        const messageId = MessageId.make(yield* uuid);
        // No model selection: the server continues this thread with its own
        // agent, model, and provider session.
        yield* environment.dispatch({
          type: "message.dispatch",
          commandId: yield* commandId,
          createdBy: "user",
          creationSource: "mcp",
          threadId: thread.id,
          messageId,
          text: input.message,
          attachments: [],
          ...(input.mode === "queue"
            ? { dispatchMode: { type: "queue_after_active" } }
            : {
                dispatchMode: { type: "start_immediately" },
                deliveryIntent: input.mode === "steer" ? "steer" : "auto",
              }),
        });
        // The server routes the message against its own serialized state.
        // Its run says where it went: none means it joined the active run.
        const run = (yield* environment.thread(thread.id)).runs.find(
          (candidate) => candidate.userMessageId === messageId,
        );
        const delivery =
          run === undefined
            ? input.mode === "steer"
              ? ("steered" as const)
              : ("during_turn" as const)
            : run.status === "queued"
              ? ("queued" as const)
              : ("new_turn" as const);
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
          message_id: messageId,
          // Taken before the send, so the next status includes the message and all that follows.
          cursor: latestCursor(projection),
        };
      }),

    control_session: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const threadId = ThreadId.make(input.session_id);
        if (input.message_ids != null && input.action !== "drop_queued") {
          return yield* new BridgeError({ message: "message_ids applies only to drop_queued." });
        }
        let projection = yield* environment.thread(threadId);
        let result: typeof ControlSessionResult.Type.result;
        const dropped: Array<string> = [];
        if (input.action === "stop") {
          const runId = interruptibleRunId(projection);
          if (runId === undefined) {
            const state = threadState(projection);
            if (state === "running" || state === "waiting" || state === "starting") {
              return yield* new BridgeError({
                code: "interrupt_not_applicable",
                state,
                message:
                  "This session's work is not a run T3 can stop. Call get_session_status before retrying stop.",
              });
            }
            result = "already_inactive";
          } else {
            // As in the UI's Stop, queued messages are held rather than started next.
            yield* environment.dispatch({
              type: "run.interrupt",
              commandId: yield* commandId,
              threadId,
              runId,
              holdQueue: true,
            });
            result = "stop_requested";
          }
        } else if (input.action === "resume_queue") {
          if (!queuedRuns(projection).some((run) => run.queueHeld === true)) {
            result = "nothing_held";
          } else {
            yield* environment.dispatch({
              type: "queue.resume",
              commandId: yield* commandId,
              threadId,
            });
            result = "queue_resumed";
          }
        } else {
          const queued = queuedRuns(projection);
          const wanted = [...new Set(input.message_ids ?? queued.map((run) => run.userMessageId))];
          const notQueued = wanted.filter((id) => !queued.some((run) => run.userMessageId === id));
          if (notQueued.length > 0) {
            return yield* new BridgeError({
              code: "not_queued",
              message: `Not queued on this session: ${notQueued.join(", ")}. They are unknown, already started, or already dropped. Nothing was dropped; call get_session_status for current queued_messages.`,
            });
          }
          for (const id of wanted) {
            const run = queued.find((candidate) => candidate.userMessageId === id)!;
            yield* environment
              .dispatch({
                type: "queued-run.cancel",
                commandId: yield* commandId,
                threadId,
                runId: run.id,
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new BridgeError({
                      code: "not_queued",
                      message: `${error.message} Message ${id} was not dropped${dropped.length > 0 ? `; already dropped: ${dropped.join(", ")}` : ""}. Call get_session_status for current queued_messages.`,
                    }),
                ),
              );
            dropped.push(id);
          }
          result = "dropped";
        }
        if (result !== "already_inactive" && result !== "nothing_held") {
          projection = yield* environment.thread(threadId);
        }
        return {
          server_id: environment.id,
          session_id: projection.thread.id,
          result,
          dropped_message_ids: dropped,
          state: threadState(projection),
          queued_messages: queuedMessages(projection),
          cursor: latestCursor(projection),
        };
      }),

    respond_to_session: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        if ((input.answers == null) === (input.decision == null)) {
          return yield* new BridgeError({
            message:
              "Pass exactly one of answers (for a question request) or decision (for an approval).",
          });
        }
        const projection = yield* environment.thread(ThreadId.make(input.session_id));
        const pending = derivePendingThreadRequests(projection);
        const question = pending.userInputs.find(
          (request) => request.requestId === input.request_id,
        );
        const approval = pending.approvals.find(
          (request) => request.requestId === input.request_id,
        );
        if (question === undefined && approval === undefined)
          return yield* new BridgeError({
            message:
              "This request is no longer pending. Call get_session_status for current requests.",
          });
        const request = {
          type: "runtime-request.respond" as const,
          threadId: projection.thread.id,
          requestId: RuntimeRequestId.make(input.request_id),
        };
        if (question !== undefined) {
          const answers = input.answers;
          if (answers == null) {
            return yield* new BridgeError({
              message: `Request ${input.request_id} is a question; respond with answers, not decision.`,
            });
          }
          if (
            Object.keys(answers).length !== question.questions.length ||
            Object.keys(answers).some(
              (id) => !question.questions.some((candidate) => candidate.id === id),
            )
          ) {
            return yield* new BridgeError({
              message: "Answer every question_id in this request, with no extra IDs.",
            });
          }
          for (const candidate of question.questions) {
            const answer = answers[candidate.id];
            const values = new Set(candidate.options.map((option) => option.value ?? option.label));
            const valid =
              typeof answer === "string"
                ? values.has(answer) ||
                  (candidate.allowCustomAnswer !== false && answer.trim().length > 0)
                : Array.isArray(answer) &&
                  candidate.multiSelect &&
                  answer.length > 0 &&
                  new Set(answer).size === answer.length &&
                  answer.every((value) => values.has(value));
            if (!valid)
              return yield* new BridgeError({
                message: `Invalid answer for question_id "${candidate.id}". Use its choices and custom/multi-select constraints from get_session_status.`,
              });
          }
          yield* environment.dispatch({ ...request, commandId: yield* commandId, answers });
        } else {
          const decision = input.decision;
          if (decision == null) {
            return yield* new BridgeError({
              message: `Request ${input.request_id} is an approval; respond with decision, not answers.`,
            });
          }
          const decisions = approval!.options?.map((option) => option.decision) ?? [
            "accept",
            "decline",
            "cancel",
            "acceptForSession",
          ];
          if (!decisions.includes(decision))
            return yield* new BridgeError({
              message: "This decision is not offered for the pending approval.",
            });
          yield* environment.dispatch({ ...request, commandId: yield* commandId, decision });
        }
        return {
          server_id: environment.id,
          session_id: projection.thread.id,
          request_id: input.request_id,
          accepted: true as const,
          cursor: latestCursor(projection),
        };
      }),

    get_session_status: (input) =>
      Effect.gen(function* () {
        const environment = yield* environments.get(input.server_id);
        const projection = yield* environment.thread(ThreadId.make(input.session_id));
        const thread = projection.thread;
        return {
          server_id: environment.id,
          session_id: thread.id,
          project_id: thread.projectId,
          title: thread.title,
          agent: thread.modelSelection.instanceId,
          model: thread.modelSelection.model,
          reasoning_effort: selectedReasoningEffort(thread.modelSelection),
          queued_messages: queuedMessages(projection),
          branch: thread.branch,
          worktree_path: thread.worktreePath,
          ...summarizeSession(projection, {
            cursor: input.cursor ?? undefined,
            limit: input.limit ?? DEFAULT_UPDATE_LIMIT,
          }),
        };
      }),
  });
});

export const BridgeToolkitHandlersLive = BridgeToolkit.toLayer(make);
