import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  type SuperThreadInternalCommand,
  type SuperThreadMemberOutcome,
  type SuperThreadMemberRun,
  type ThreadId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

import { isSameMember, superThreadUpdatedEvent } from "./superThreadState.ts";

type WakeCommand = Extract<
  SuperThreadInternalCommand,
  { readonly type: "super_thread.member.wake" }
>;
type WakeEvent =
  | ReturnType<typeof superThreadUpdatedEvent>
  | Omit<Extract<OrchestrationV2DomainEvent, { readonly type: "message.updated" }>, "id">;

const WAKE_COMMAND_PREFIX = "super-thread-wake";
const WAKE_MESSAGE_PREFIX = `message:${WAKE_COMMAND_PREFIX}:`;
const WAKE_HEADER = "Threads you launched changed state:";
const WAKE_FOOTER =
  "Read each with t3_thread_read, passing its environmentId, before you act on it. End your turn when nothing is left for you to do; the next change wakes you again.";

/** Names one outcome of one member run, so a replayed report wakes the super thread once. */
export const memberWakeCommandId = (
  superThreadId: ThreadId,
  run: SuperThreadMemberRun,
  outcome: SuperThreadMemberOutcome,
  requestId?: string,
) =>
  CommandId.make(
    [
      WAKE_COMMAND_PREFIX,
      superThreadId,
      run.environmentId,
      run.threadId,
      run.runId,
      outcome,
      ...(requestId === undefined ? [] : [requestId]),
    ].join(":"),
  );

export const isMemberWakeMessage = (messageId: string) => messageId.startsWith(WAKE_MESSAGE_PREFIX);

const OUTCOME_TEXT: Record<Exclude<SuperThreadMemberOutcome, "stopped">, string> = {
  completed: "completed its run",
  failed: "failed",
  waiting: "is waiting for the user to answer an approval or a question",
};

const wakeLine = (command: WakeCommand, outcome: Exclude<SuperThreadMemberOutcome, "stopped">) => {
  const title = command.title?.trim();
  const name = title ? `"${title}" ` : "";
  return `- ${name}(threadId ${command.run.threadId}, environmentId ${command.run.environmentId}) ${OUTCOME_TEXT[outcome]}.`;
};

const wakeText = (lines: ReadonlyArray<string>) => [WAKE_HEADER, ...lines, WAKE_FOOTER].join("\n");

const wakeNotification = (
  lines: ReadonlyArray<string>,
  command: WakeCommand,
  outcome: Exclude<SuperThreadMemberOutcome, "stopped">,
): OrchestrationV2Notification => {
  if (lines.length > 1) {
    return {
      source: { kind: "system" },
      outcome: "updated",
      summary: `${lines.length} launched threads changed state`,
    };
  }
  const name = command.title?.trim() || command.run.threadId;
  return {
    source: { kind: "system" },
    outcome: outcome === "waiting" ? "updated" : outcome,
    summary: outcome === "waiting" ? `${name} is waiting for you` : `${name} ${outcome}`,
  };
};

/**
 * What one member outcome does to its super thread: nothing on a settled or archived one, a line
 * added to a wake still queued, or a new queued wake. Runs under the super thread's command lock,
 * so a settle commits either before (no wake) or after (it cancels a queued wake, or refuses a
 * super thread the wake set running).
 */
export function planMemberWake(
  input: {
    readonly thread: OrchestrationV2AppThread;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  },
  command: WakeCommand,
  now: DateTime.Utc,
):
  | { readonly refused: string }
  | {
      readonly events: ReadonlyArray<WakeEvent>;
      readonly dispatch:
        | Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>
        | undefined;
    } {
  const { thread } = input;
  const state = thread.superThread;
  if (state === undefined) return { refused: `Thread ${thread.id} is not a super thread.` };
  if (thread.deletedAt !== null) return { refused: `Thread ${thread.id} is deleted.` };
  if (!state.members.some((member) => isSameMember(member, command.run))) {
    return { refused: `Thread ${command.run.threadId} is not a member of ${thread.id}.` };
  }
  const followed = state.following ?? [];
  const following = followed.filter(
    (entry) => !(isSameMember(entry, command.run) && entry.runId === command.run.runId),
  );
  const next =
    following.length === followed.length
      ? thread
      : { ...thread, superThread: { ...state, following } };
  const events: Array<WakeEvent> = next === thread ? [] : [superThreadUpdatedEvent(next, now)];
  const outcome = command.outcome;
  if (
    outcome === "stopped" ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.settledAt !== null
  ) {
    // A command must commit an event; the thread record stands in when nothing else changed.
    return { events: [superThreadUpdatedEvent(next, now)], dispatch: undefined };
  }
  const line = wakeLine(command, outcome);
  const queued = input.runs.find(
    (run) => run.status === "queued" && isMemberWakeMessage(run.userMessageId),
  );
  const message =
    queued === undefined
      ? undefined
      : input.messages.find((candidate) => candidate.id === queued.userMessageId);
  if (queued !== undefined && message !== undefined) {
    const lines = [...message.text.split("\n").filter((text) => text.startsWith("- ")), line];
    events.push({
      type: "message.updated",
      threadId: thread.id,
      runId: queued.id,
      ...(queued.rootNodeId === null ? {} : { nodeId: queued.rootNodeId }),
      providerInstanceId: queued.providerInstanceId,
      occurredAt: now,
      payload: {
        ...message,
        text: wakeText(lines),
        notification: wakeNotification(lines, command, outcome),
        updatedAt: now,
      },
    });
    return { events, dispatch: undefined };
  }
  return {
    events,
    dispatch: {
      type: "message.dispatch",
      commandId: command.commandId,
      threadId: thread.id,
      messageId: MessageId.make(`message:${command.commandId}`),
      text: wakeText([line]),
      notification: wakeNotification([line], command, outcome),
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    },
  };
}
