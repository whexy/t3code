import { NodeId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { summarizeSession } from "./status.ts";
import {
  approvalItem,
  assistantMessage,
  at,
  checkpoint,
  command,
  projection,
  questionItem,
  run,
  runtimeRequest,
  userMessage,
} from "./testing.ts";

const user = userMessage("user-1", "Fix the flaky test", 1);

describe("summarizeSession", () => {
  it("reports what changed since the cursor, including a message that kept streaming", () => {
    const reasoning = {
      ...assistantMessage("thinking", "private chain of thought", 2),
      type: "reasoning" as const,
    };
    const running = projection({
      items: [
        user,
        reasoning,
        command("started", "vp lint", 2, { status: "running", completedAt: null }),
        command("tests", "vp test\n run", 3),
        assistantMessage("reply", "Looking at", 4, { streaming: true }),
      ],
    });
    const first = summarizeSession(running, { limit: 2 });
    expect(first.state).toBe("running");
    expect(first.updates).toEqual([
      { at: at(3), type: "activity", text: "Command run: vp test run" },
      { at: at(4), type: "assistant_message", text: "Looking at", streaming: true },
    ]);
    expect(first.omitted_updates).toBe(1);

    const later = projection({
      items: [
        user,
        command("tests", "vp test\n run", 3),
        assistantMessage("reply", "Looking at the retry loop", 4, {
          updatedAt: DateTime.makeUnsafe(at(6)),
        }),
        command("edit", "git diff", 5, { status: "failed" }),
      ],
    });
    const second = summarizeSession(later, { cursor: first.cursor, limit: 10 });
    expect(second.updates.map((update) => update.text)).toEqual([
      "Command run failed: git diff",
      "Looking at the retry loop",
    ]);
    expect(summarizeSession(later, { cursor: second.cursor, limit: 10 }).updates).toEqual([]);
  });

  it("waits while an approval is pending and resumes once the server resolves it", () => {
    const item = approvalItem("request-1", 3, { prompt: "rm -rf build" });
    const waiting = summarizeSession(
      projection({
        items: [user, item],
        runtimeRequests: [runtimeRequest("request-1", "command")],
      }),
      { limit: 5 },
    );
    expect(waiting.state).toBe("waiting");
    expect(waiting.waiting_for).toEqual({
      approvals: [{ request_id: "request-1", kind: "command", detail: "rm -rf build" }],
      questions: [],
    });
    expect(waiting.updates.at(-1)).toMatchObject({ text: "Approval requested: rm -rf build" });

    const resumed = summarizeSession(
      projection({
        items: [user, item],
        runtimeRequests: [runtimeRequest("request-1", "command", { status: "resolved" })],
      }),
      { limit: 5 },
    );
    expect(resumed.state).toBe("running");
    expect(resumed.waiting_for).toBeUndefined();
  });

  it("is starting while the workspace prepares, and failed with the run's error", () => {
    expect(
      summarizeSession(projection({ runs: [run({ status: "preparing", startedAt: null })] }), {
        limit: 5,
      }).state,
    ).toBe("starting");

    const failure = {
      ...command("failure", "", 5),
      type: "error" as const,
      status: "failed" as const,
      failure: {
        class: "permission_error" as const,
        message: "Codex is not signed in.",
        code: null,
        retryable: false,
      },
    };
    const failed = summarizeSession(
      projection({
        runs: [run({ status: "failed", completedAt: DateTime.makeUnsafe(at(5)) })],
        items: [user, failure],
      }),
      { limit: 5 },
    );
    expect(failed).toMatchObject({ state: "failed", error: "Codex is not signed in." });
    expect(failed.updates.at(-1)).toMatchObject({ text: "Error: Codex is not signed in." });
  });

  it("reports the files the latest run changed, not a subagent's nested checkpoint", () => {
    const summary = summarizeSession(
      projection({
        runs: [run({ status: "completed", completedAt: DateTime.makeUnsafe(at(20)) })],
        checkpoints: [
          checkpoint([
            { path: "src/retry.ts", kind: "modified", additions: 12, deletions: 3 },
            { path: "src/retry.test.ts", kind: "added", additions: 40, deletions: 0 },
          ]),
          checkpoint([{ path: "notes.md", kind: "added", additions: 1, deletions: 0 }], {
            appRunOrdinal: null,
            nodeId: NodeId.make("node-subagent"),
          }),
        ],
      }),
      { limit: 5 },
    );
    expect(summary.state).toBe("completed");
    expect(summary.turn).toEqual({ started_at: at(2), completed_at: at(20) });
    expect(summary.changed_files).toMatchObject({ count: 2, additions: 52, deletions: 3 });
  });

  it("leaves out the history a fork inherited from its source session", () => {
    const inherited = userMessage("source", "Earlier work in the source thread", 0);
    const fork = projection();
    const summary = summarizeSession(
      {
        ...fork,
        visibleTurnItems: [
          {
            position: 0,
            visibility: "inherited",
            sourceThreadId: ThreadId.make("source-thread"),
            sourceItemId: TurnItemId.make("source"),
            item: { ...inherited, threadId: ThreadId.make("source-thread") },
          },
          ...fork.visibleTurnItems.map((row) => ({ ...row, position: row.position + 1 })),
        ],
      },
      { limit: 5 },
    );
    expect(summary.updates.map((update) => update.text)).toEqual(["Fix the flaky test"]);
  });
});

it("preserves complete approval details and warnings alongside actionable question values", () => {
  const detail = "deploy production " + "important context ".repeat(80);
  const result = summarizeSession(
    projection({
      items: [
        user,
        approvalItem("approve-id", 3, {
          requestKind: "permission",
          appName: "Deploy",
          prompt: detail,
          options: [{ decision: "accept", label: "Allow once", warning: "Production" }],
        }),
        questionItem("input-id", 4, [
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
        ]),
      ],
      runtimeRequests: [
        runtimeRequest("approve-id", "permission"),
        runtimeRequest("input-id", "user_input"),
      ],
    }),
    { cursor: at(20), limit: 1 },
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
