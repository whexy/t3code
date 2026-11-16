import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";

import { selectedReasoningEffort } from "./agents.ts";
import { BridgeError, type Environments } from "./environment.ts";
import { resolveLaunch, sessionTitle } from "./launch.ts";

const text = (description: string) =>
  Schema.String.annotate({ description }).pipe(Schema.decodeTo(TrimmedNonEmptyString));
/** OpenAI-style clients send null for an optional argument they leave out. */
const optional = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const Parameters = Schema.Struct({
  server_id: text("server_id from list_projects: the server the coordinator runs on."),
  project_id: optional(
    text(
      "project_id from list_projects to run the coordinator in that project; omit to use the server's scratch folder.",
    ),
  ),
  task: text(
    "The whole goal for the coordinator, sent as its first message. Name the projects and servers it should work in.",
  ),
  agent: optional(text("Agent id or name for the coordinator, e.g. codex or Claude.")),
  model: optional(text("Model id or name for that agent.")),
  reasoning_effort: optional(
    text("A reasoning_efforts value list_projects reports for the selected model, e.g. high."),
  ),
});

const Success = Schema.Struct({
  server_id: Schema.String,
  session_id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  agent: Schema.String,
  model: Schema.String,
  reasoning_effort: Schema.NullOr(Schema.String),
  runtime_mode: Schema.String,
  state: Schema.Literal("queued"),
  next_step: Schema.String,
});

export const CreateSuperThreadTool = Tool.make("create_super_thread", {
  description:
    "Start a super thread: a coordinator agent for one task that spans several projects or servers. The coordinator launches its own threads in those projects, on this server or on servers linked to it; T3 Code groups them under the super thread in its sidebar and shows a goal board the coordinator keeps. Use it only when the user wants one task coordinated across several threads; for work in one project, call create_session. It runs in the server's scratch folder unless project_id is given, with the same agent, model and reasoning_effort choices as create_session. Follow and continue it like any session, with get_session_status and send_session_message on the returned session_id.",
  parameters: Parameters,
  success: Success,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Start a super thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const createSuperThread = Effect.fn("createSuperThread")(function* (
  environments: typeof Environments.Service,
  uuid: Effect.Effect<string>,
  input: typeof Parameters.Type,
): Effect.fn.Return<typeof Success.Type, BridgeError> {
  const environment = yield* environments.get(input.server_id);
  const { project, modelSelection, runtimeMode } = yield* resolveLaunch(environment, {
    projectId: input.project_id ?? null,
    agent: input.agent,
    model: input.model,
    reasoningEffort: input.reasoning_effort,
  });
  const threadId = ThreadId.make(yield* uuid);
  const title = sessionTitle(input.task);
  yield* environment.launchThread({
    commandId: CommandId.make(yield* uuid),
    creationSource: "mcp",
    threadId,
    projectId: project.id,
    title,
    generateTitle: true,
    modelSelection,
    runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    workspaceStrategy: { type: "root" },
    superThread: true,
    initialMessage: { messageId: MessageId.make(yield* uuid), text: input.task, attachments: [] },
  });
  yield* Effect.logInfo("created super thread", {
    server: environment.id,
    project: project.id,
    session: threadId,
    agent: modelSelection.instanceId,
    model: modelSelection.model,
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
    state: "queued" as const,
    next_step:
      "The coordinator plans and launches its threads itself. To hear when it finishes or needs the user, call get_session_status with wait: true, passing back each returned cursor.",
  };
});
