import { CheckpointRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { summarizeSession } from "./status.ts";
import { activity, at, message, NOW, thread, turnId } from "./testing.ts";

describe("summarizeSession", () => {
  it("reports what changed since the cursor, including a message that kept streaming", () => {
    const running = thread({
      messages: [
        message("user-1", "user", "Fix the flaky test", 1),
        message("thinking", "reasoning", "private chain of thought", 2),
        message("reply", "assistant", "Looking at", 4, { streaming: true }),
      ],
      activities: [
        activity("start", "tool.started", 2),
        activity("run", "tool.completed", 3, { detail: "Bash:  vp test\n run" }),
        activity("meter", "context-window.updated", 3, {}, { tone: "info" }),
      ],
    });
    const first = summarizeSession(running, { limit: 2, now: NOW });
    expect(first.state).toBe("running");
    expect(first.updates).toEqual([
      { at: at(3), type: "activity", text: "Command run: Bash: vp test run" },
      { at: at(4), type: "assistant_message", text: "Looking at", streaming: true },
    ]);
    expect(first.omitted_updates).toBe(1);

    const later = thread({
      ...running,
      messages: [
        ...running.messages.slice(0, 2),
        message("reply", "assistant", "Looking at the retry loop", 4, { updatedAt: at(6) }),
      ],
      activities: [...running.activities, activity("edit", "tool.completed", 5)],
    });
    const second = summarizeSession(later, { cursor: first.cursor, limit: 10, now: NOW });
    expect(second.updates.map((update) => update.text)).toEqual([
      "Command run",
      "Looking at the retry loop",
    ]);
    expect(second.omitted_updates).toBe(0);
    expect(summarizeSession(later, { cursor: second.cursor, limit: 10, now: NOW }).updates).toEqual(
      [],
    );
  });

  it("waits while an approval is open and resumes once it is resolved", () => {
    const requested = activity(
      "ask",
      "approval.requested",
      3,
      { requestId: "request-1", requestKind: "command", detail: "rm -rf build" },
      { tone: "approval" },
    );
    const waiting = summarizeSession(thread({ activities: [requested] }), { limit: 5, now: NOW });
    expect(waiting.state).toBe("waiting");
    expect(waiting.waiting_for).toEqual({
      approvals: [{ request_id: "request-1", kind: "command", detail: "rm -rf build" }],
      questions: [],
    });

    const resolved = activity(
      "answer",
      "approval.resolved",
      4,
      { requestId: "request-1" },
      { tone: "approval" },
    );
    const resumed = summarizeSession(thread({ activities: [requested, resolved] }), {
      limit: 5,
      now: NOW,
    });
    expect(resumed.state).toBe("running");
    expect(resumed.waiting_for).toBeUndefined();
  });

  it("is queued until a session adopts the turn, and failed when the session errors", () => {
    const unadopted = thread({ latestTurn: null, session: null });
    expect(summarizeSession(unadopted, { limit: 5, now: NOW }).state).toBe("queued");

    const failed = summarizeSession(
      thread({
        latestTurn: null,
        session: {
          ...thread().session!,
          status: "error",
          activeTurnId: null,
          lastError: "Codex is not signed in.",
        },
      }),
      { limit: 5, now: NOW },
    );
    expect(failed).toMatchObject({ state: "failed", error: "Codex is not signed in." });
  });

  it("reports the files the completed turn changed", () => {
    const completed = summarizeSession(
      thread({
        latestTurn: {
          ...thread().latestTurn!,
          state: "completed",
          completedAt: at(20),
        },
        session: { ...thread().session!, status: "ready", activeTurnId: null },
        checkpoints: [
          {
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoint-1"),
            status: "ready",
            files: [
              { path: "src/retry.ts", kind: "modified", additions: 12, deletions: 3 },
              { path: "src/retry.test.ts", kind: "added", additions: 40, deletions: 0 },
            ],
            assistantMessageId: null,
            completedAt: at(20),
          },
        ],
      }),
      { limit: 5, now: NOW },
    );
    expect(completed.state).toBe("completed");
    expect(completed.turn).toEqual({ started_at: at(2), completed_at: at(20) });
    expect(completed.changed_files).toMatchObject({ count: 2, additions: 52, deletions: 3 });
  });
});

it("preserves complete approval details and warnings alongside actionable question values", () => {
  const detail = "deploy production " + "important context ".repeat(80);
  const result = summarizeSession(
    thread({
      activities: [
        activity("approve", "approval.requested", 3, {
          requestId: "approve-id",
          requestKind: "permission",
          appName: "Deploy",
          detail,
          options: [{ decision: "accept", label: "Allow once", warning: "Production" }],
        }),
        activity("questions", "user-input.requested", 4, {
          requestId: "input-id",
          questions: [
            {
              id: " native-id ",
              header: "Target",
              question: "Which target?",
              allowCustomAnswer: false,
              multiSelect: true,
              options: [
                { label: "Production", value: " production-id ", description: "Live target" },
              ],
            },
            { id: "notes", header: "Notes", question: "Any notes?", options: [] },
          ],
        }),
      ],
    }),
    { cursor: at(20), limit: 1, now: NOW },
  );
  expect(result.updates).toEqual([]);
  expect(result.waiting_for).toEqual({
    approvals: [
      {
        request_id: "approve-id",
        kind: "permission",
        app_name: "Deploy",
        detail,
        options: [{ decision: "accept", label: "Allow once", warning: "Production" }],
      },
    ],
    questions: [
      {
        request_id: "input-id",
        question_id: " native-id ",
        header: "Target",
        question: "Which target?",
        options: ["Production"],
        choices: [{ label: "Production", value: " production-id ", description: "Live target" }],
        allow_custom_answer: false,
        multi_select: true,
      },
      {
        request_id: "input-id",
        question_id: "notes",
        header: "Notes",
        question: "Any notes?",
        options: [],
        choices: [],
        allow_custom_answer: true,
        multi_select: false,
      },
    ],
  });
});
