import {
  EventId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

/** Test fixtures: a thread one turn into fixing a flaky test, running on Codex. */
export const at = (second: number) => `2026-09-28T12:00:${String(second).padStart(2, "0")}.000Z`;
export const NOW = at(30);
export const turnId = TurnId.make("turn-1");

export function message(
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  second: number,
  overrides: Partial<OrchestrationMessage> = {},
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId,
    streaming: false,
    createdAt: at(second),
    updatedAt: at(second),
    ...overrides,
  };
}

export function activity(
  id: string,
  kind: string,
  second: number,
  payload: unknown = {},
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind,
    summary: kind === "tool.completed" ? "Command run" : kind,
    payload,
    turnId,
    createdAt: at(second),
    ...overrides,
  };
}

export function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Fix the flaky test",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: at(1),
      startedAt: at(2),
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: at(1),
    updatedAt: at(10),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [message("user-1", "user", "Fix the flaky test", 1)],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: at(2),
    },
    ...overrides,
  };
}
