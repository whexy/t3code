import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { hasQueuedTurnStart } from "@t3tools/client-runtime/state/thread-settled";
import * as Predicate from "effect/Predicate";

const MAX_MESSAGE_CHARS = 4_000;
const MAX_ACTIVITY_CHARS = 240;
const MAX_CHANGED_FILES = 20;

/** Activities worth narrating; tool starts, token meters, and task progress are noise. */
const REPORTED_ACTIVITY_KINDS = new Set([
  "tool.completed",
  "task.completed",
  "approval.requested",
  "user-input.requested",
  "runtime.error",
  "runtime.warning",
]);

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

const cut = (text: string, max: number) =>
  text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true as const } : { text };

function activityText(activity: OrchestrationThreadActivity): string {
  const payload = Predicate.isObject(activity.payload) ? activity.payload : {};
  const detail = [payload.detail, payload.message].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return detail === undefined
    ? activity.summary
    : `${activity.summary}: ${detail.replace(/\s+/g, " ").trim()}`;
}

function collectUpdates(thread: OrchestrationThread): ReadonlyArray<SessionUpdate> {
  const updates: Array<SessionUpdate> = [];
  for (const message of thread.messages) {
    if (message.role === "reasoning") continue;
    updates.push({
      // A streaming message grows in place; its updatedAt moves it past the cursor again.
      at: message.updatedAt,
      type: `${message.role}_message`,
      ...cut(message.text, MAX_MESSAGE_CHARS),
      ...(message.streaming ? { streaming: true as const } : {}),
    });
  }
  for (const activity of thread.activities) {
    if (!REPORTED_ACTIVITY_KINDS.has(activity.kind) && activity.tone !== "error") continue;
    updates.push({
      at: activity.createdAt,
      type: "activity",
      ...cut(activityText(activity), MAX_ACTIVITY_CHARS),
    });
  }
  return updates.toSorted((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/** What the sidebar reads to place a thread. Shells carry it; full threads derive it. */
export interface StateSignals {
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly latestUserMessageAt: string | null;
  /** An approval or a question is open. */
  readonly waiting: boolean;
}

/** Mirrors the sidebar's precedence: a raised hand, then live work, then how the last turn ended. */
export function sessionState(signals: StateSignals, now: string): SessionState {
  const { session, latestTurn } = signals;
  if (signals.waiting) return "waiting";
  if (session?.status === "starting") return "starting";
  if (session?.status === "running" || latestTurn?.state === "running") return "running";
  if (hasQueuedTurnStart(signals, { now })) return "queued";
  if (session?.status === "error" || latestTurn?.state === "error") return "failed";
  if (latestTurn?.state === "interrupted") return "interrupted";
  if (latestTurn?.state === "completed") return "completed";
  return "idle";
}

/** A full thread's state. Its activities hold the open requests the shell would flag. */
export function threadState(thread: OrchestrationThread, now: string): SessionState {
  const pending = derivePendingRequests(thread.activities);
  return sessionState(
    {
      session: thread.session,
      latestTurn: thread.latestTurn,
      latestUserMessageAt:
        thread.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
      waiting: pending.approvals.length > 0 || pending.userInputs.length > 0,
    },
    now,
  );
}

function waitingFor(thread: OrchestrationThread) {
  const pending = derivePendingRequests(thread.activities);
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
        multi_select: question.multiSelect === true,
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

export const turnTimes = (latestTurn: OrchestrationLatestTurn | null) =>
  latestTurn === null
    ? null
    : {
        started_at: latestTurn.startedAt ?? latestTurn.requestedAt,
        completed_at: latestTurn.completedAt,
      };

/** A cursor past everything the thread holds now, so the next status reports only what follows. */
export const latestCursor = (thread: OrchestrationThread) =>
  collectUpdates(thread).at(-1)?.at ?? thread.updatedAt;

function changedFiles(thread: OrchestrationThread) {
  const turnId = thread.latestTurn?.turnId;
  const checkpoint = thread.checkpoints.findLast(
    (candidate) => candidate.turnId === turnId && candidate.status === "ready",
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
  thread: OrchestrationThread,
  options: { readonly cursor?: string | undefined; readonly limit: number; readonly now: string },
) {
  const state = threadState(thread, options.now);
  const error =
    state === "failed"
      ? (thread.session?.lastError ??
        thread.activities.findLast((activity) => activity.tone === "error")?.summary)
      : undefined;
  const since = options.cursor === undefined ? Number.NaN : Date.parse(options.cursor);
  const fresh = collectUpdates(thread).filter(
    (update) => Number.isNaN(since) || Date.parse(update.at) > since,
  );
  const updates = fresh.slice(-options.limit);
  const files = changedFiles(thread);
  return {
    state,
    ...(error === undefined ? {} : { error }),
    ...(state === "waiting" ? { waiting_for: waitingFor(thread) } : {}),
    turn: turnTimes(thread.latestTurn),
    ...(files === undefined ? {} : { changed_files: files }),
    updates,
    omitted_updates: fresh.length - updates.length,
    cursor: fresh.at(-1)?.at ?? options.cursor ?? thread.updatedAt,
  };
}
