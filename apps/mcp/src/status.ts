import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import type { ThreadRunSummary, ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import {
  deriveLatestThreadRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import * as DateTime from "effect/DateTime";

const MAX_MESSAGE_CHARS = 4_000;
const MAX_ACTIVITY_CHARS = 240;
const MAX_CHANGED_FILES = 20;

export type SessionState =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "idle";

export interface SessionUpdate {
  readonly at: string;
  readonly type: "user_message" | "assistant_message" | "system_message" | "activity";
  readonly text: string;
  readonly streaming?: true;
  readonly truncated?: true;
}

const iso = DateTime.formatIso;

const cut = (text: string, max: number) =>
  text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true as const } : { text };

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const TERMINAL_ITEM_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** A finished tool call, labelled the way the old activity feed named it. */
function toolText(item: OrchestrationV2TurnItem): string | null {
  const failed = item.status === "failed" ? " failed" : "";
  switch (item.type) {
    case "command_execution":
      return `Command run${failed}: ${oneLine(item.input)}`;
    case "file_change":
      return `File change${failed}: ${item.fileName}`;
    case "dynamic_tool":
      return `${item.toolName ?? "Tool call"}${failed}${item.title ? `: ${oneLine(item.title)}` : ""}`;
    case "web_search":
      return `Web search${failed}${item.patterns?.length ? `: ${item.patterns.join(", ")}` : ""}`;
    case "file_search":
      return `File search${failed}${item.pattern ? `: ${item.pattern}` : ""}`;
    case "subagent":
      return `Subagent ${item.status}: ${oneLine(item.title ?? item.prompt)}`;
    default:
      return null;
  }
}

/** Messages and the timeline entries worth narrating; tool starts and reasoning are noise. */
function itemUpdate(item: OrchestrationV2TurnItem): SessionUpdate | null {
  switch (item.type) {
    case "user_message":
      return {
        at: iso(item.updatedAt),
        type: "user_message",
        ...cut(item.text, MAX_MESSAGE_CHARS),
      };
    case "assistant_message":
      return {
        // A streaming message grows in place; its updatedAt moves it past the cursor again.
        at: iso(item.updatedAt),
        type: "assistant_message",
        ...cut(item.text, MAX_MESSAGE_CHARS),
        ...(item.streaming ? { streaming: true as const } : {}),
      };
    case "system_notice":
      return {
        at: iso(item.updatedAt),
        type: "system_message",
        ...cut(item.message, MAX_MESSAGE_CHARS),
      };
    case "approval_request":
      return {
        at: iso(item.startedAt ?? item.updatedAt),
        type: "activity",
        ...cut(
          `Approval requested: ${oneLine(item.prompt ?? item.requestKind)}`,
          MAX_ACTIVITY_CHARS,
        ),
      };
    case "user_input_request":
      return {
        at: iso(item.startedAt ?? item.updatedAt),
        type: "activity",
        ...cut(
          `Question: ${item.questions.map((question) => oneLine(question.question)).join(" ")}`,
          MAX_ACTIVITY_CHARS,
        ),
      };
    case "error":
      return {
        at: iso(item.updatedAt),
        type: "activity",
        ...cut(`Error: ${oneLine(item.failure.message)}`, MAX_ACTIVITY_CHARS),
      };
    default: {
      if (!TERMINAL_ITEM_STATUSES.has(item.status)) return null;
      const text = toolText(item);
      return text === null
        ? null
        : {
            at: iso(item.completedAt ?? item.updatedAt),
            type: "activity",
            ...cut(text, MAX_ACTIVITY_CHARS),
          };
    }
  }
}

function collectUpdates(projection: OrchestrationV2ThreadProjection) {
  return projection.visibleTurnItems
    .flatMap((row) => {
      // Rows a fork inherits belong to the session it came from.
      if (row.visibility !== "local") return [];
      const update = itemUpdate(row.item);
      return update === null ? [] : [update];
    })
    .toSorted((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/** What the sidebar reads to place a thread. Shells carry it; full projections derive it. */
export interface StateSignals {
  readonly runtime: Pick<ThreadRuntimeSummary, "status"> | null;
  readonly latestRun: Pick<ThreadRunSummary, "status"> | null;
  /** An approval or a question is open. */
  readonly waiting: boolean;
}

/** A raised hand first, then the run doing the work, then how the last run ended. */
export function sessionState(signals: StateSignals): SessionState {
  if (signals.waiting) return "waiting";
  const runtimeStatus = signals.runtime?.status ?? "idle";
  // Idle runtime with a run means background work holds it; report how that run ended.
  const status = runtimeStatus === "idle" ? (signals.latestRun?.status ?? "idle") : runtimeStatus;
  switch (status) {
    case "preparing":
    case "starting":
      return "starting";
    case "cancelled":
      return "interrupted";
    case "rolled_back":
      return "idle";
    default:
      return status;
  }
}

/** A projection's state. Its runtime requests hold the open requests the shell would flag. */
export function threadState(projection: OrchestrationV2ThreadProjection): SessionState {
  const pending = derivePendingThreadRequests(projection);
  return sessionState({
    runtime: deriveThreadRuntime(projection),
    latestRun: deriveLatestThreadRun(projection),
    waiting: pending.approvals.length > 0 || pending.userInputs.length > 0,
  });
}

function waitingFor(projection: OrchestrationV2ThreadProjection) {
  const pending = derivePendingThreadRequests(projection);
  return {
    approvals: pending.approvals.map((approval) => ({
      request_id: approval.requestId,
      kind: approval.requestKind,
      ...(approval.appName === undefined ? {} : { app_name: approval.appName }),
      ...(approval.options === undefined ? {} : { options: approval.options }),
      ...(approval.detail === undefined ? {} : { detail: approval.detail }),
    })),
    questions: pending.userInputs.flatMap((input) =>
      input.questions.map((question) => ({
        request_id: input.requestId,
        question_id: question.id,
        header: question.header,
        multi_select: question.multiSelect,
        allow_custom_answer: question.allowCustomAnswer !== false,
        choices: question.options.map((option) => ({
          ...option,
          value: option.value ?? option.label,
        })),
        question: question.question,
        options: question.options.map((option) => option.label),
      })),
    ),
  };
}

export const turnTimes = (
  latestRun: Pick<ThreadRunSummary, "requestedAt" | "startedAt" | "completedAt"> | null,
) => {
  const startedAt = latestRun?.startedAt ?? latestRun?.requestedAt ?? null;
  return latestRun === null || startedAt === null
    ? null
    : { started_at: startedAt, completed_at: latestRun.completedAt };
};

/** A cursor past everything the projection holds now, so the next status reports only what follows. */
export const latestCursor = (projection: OrchestrationV2ThreadProjection) =>
  collectUpdates(projection).at(-1)?.at ?? iso(projection.updatedAt);

function changedFiles(projection: OrchestrationV2ThreadProjection, runId: RunId | undefined) {
  // The root run's checkpoint; subagent checkpoints nest under it and do not count.
  const checkpoint = projection.checkpoints.findLast(
    (candidate) =>
      candidate.runId === runId && candidate.appRunOrdinal !== null && candidate.status === "ready",
  );
  if (checkpoint === undefined || checkpoint.files.length === 0) return undefined;
  return {
    count: checkpoint.files.length,
    additions: checkpoint.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: checkpoint.files.reduce((sum, file) => sum + file.deletions, 0),
    files: checkpoint.files
      .slice(0, MAX_CHANGED_FILES)
      .map(({ path, additions, deletions }) => ({ path, additions, deletions })),
  };
}

/**
 * Summarizes a thread for "how is it going?". Updates newer than `cursor`
 * come back oldest first, bounded to the latest `limit`; the returned cursor
 * makes the next call report only what changed since this one.
 */
export function summarizeSession(
  projection: OrchestrationV2ThreadProjection,
  options: { readonly cursor?: string | undefined; readonly limit: number },
) {
  const runtime = deriveThreadRuntime(projection);
  const latestRun = deriveLatestThreadRun(projection);
  const state = threadState(projection);
  const error = state === "failed" ? (runtime?.lastError ?? undefined) : undefined;
  const since = options.cursor === undefined ? Number.NaN : Date.parse(options.cursor);
  const fresh = collectUpdates(projection).filter(
    (update) => Number.isNaN(since) || Date.parse(update.at) > since,
  );
  const updates = fresh.slice(-options.limit);
  const files = changedFiles(projection, latestRun?.runId);
  return {
    state,
    ...(error === undefined ? {} : { error }),
    ...(state === "waiting" ? { waiting_for: waitingFor(projection) } : {}),
    turn: turnTimes(latestRun),
    ...(files === undefined ? {} : { changed_files: files }),
    updates,
    omitted_updates: fresh.length - updates.length,
    cursor: fresh.at(-1)?.at ?? options.cursor ?? iso(projection.updatedAt),
  };
}
