import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type SuperThreadMember,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { deriveSuperThreadSections, planSuperThreadSettle } from "./superThreads.ts";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");
const settledAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");

function at(minute: number) {
  return DateTime.makeUnsafe(`2026-06-20T00:${String(minute).padStart(2, "0")}:00.000Z`);
}

function shell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
  environmentId = local,
) {
  const threadId = ThreadId.make(id);
  return presentThreadShell(environmentId, {
    ...v2ThreadShell,
    id: threadId,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    ...overrides,
  });
}

const member = (id: string, environmentId = local): SuperThreadMember => ({
  environmentId,
  threadId: ThreadId.make(id),
});

const settled = { settledOverride: "settled", settledAt } as const;
const working = {
  latestRunId: RunId.make("run-w"),
  status: "running",
  activeRunId: RunId.make("run-w"),
} as const;
const asking = {
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make("request-1"),
    kind: "user_input",
    createdAt: at(5),
  },
} as const;
const done = (minute: number) =>
  ({
    latestRunId: RunId.make(`run-${minute}`),
    status: "completed",
    latestRunCompletedAt: at(minute),
  }) as const;

function superShell(id: string, members: SuperThreadMember[], overrides = {}) {
  return shell(id, { superThread: { members }, ...overrides });
}

const keyOf = (thread: ReturnType<typeof shell>) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
const idsOf = (threads: ReadonlyArray<ReturnType<typeof shell>>) => threads.map((t) => t.id);

describe("deriveSuperThreadSections", () => {
  it("shows a settled header while a member is unsettled, claiming header and unsettled members", () => {
    const header = superShell("super", [member("a"), member("b")], settled);
    const a = shell("a", done(3));
    const b = shell("b", { ...done(4), ...settled });
    const { sections, claimedThreadKeys } = deriveSuperThreadSections([header, a, b]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.header.id).toBe("super");
    expect(idsOf(sections[0]!.rows)).toEqual(["a"]);
    // The settled member stays on the normal Settled shelf.
    expect([...claimedThreadKeys].toSorted()).toEqual([keyOf(a), keyOf(header)].toSorted());
  });

  it("hides the section and claims nothing when the header and all members are settled", () => {
    const header = superShell("super", [member("a")], settled);
    const result = deriveSuperThreadSections([header, shell("a", settled)]);
    expect(result.sections).toEqual([]);
    expect(result.claimedThreadKeys.size).toBe(0);
  });

  it("shows an unsettled header with no rows when every member is settled (unsettling the header leaves members settled)", () => {
    const header = superShell("super", [member("a")]);
    const { sections, claimedThreadKeys } = deriveSuperThreadSections([
      header,
      shell("a", settled),
    ]);
    expect(sections.map((section) => [section.header.id, section.rows.length])).toEqual([
      ["super", 0],
    ]);
    expect([...claimedThreadKeys]).toEqual([keyOf(header)]);
  });

  it("leaves out archived headers and archived, deleted or unheld members", () => {
    const archivedHeader = superShell("old", [member("x")], { archivedAt: at(1) });
    const header = superShell("super", [
      member("archived"),
      member("deleted"),
      member("elsewhere", remote),
    ]);
    const { sections, claimedThreadKeys } = deriveSuperThreadSections([
      archivedHeader,
      shell("x"),
      header,
      shell("archived", { archivedAt: at(2) }),
      shell("deleted", { deletedAt: at(2) }),
    ]);
    expect(sections.map((section) => section.header.id)).toEqual(["super"]);
    expect(sections[0]!.rows).toEqual([]);
    expect([...claimedThreadKeys]).toEqual([keyOf(header)]);
  });

  it("orders rows needing you first, then working, then finished, newest first within each", () => {
    const header = superShell("super", [
      member("working"),
      member("done-old"),
      member("asking"),
      member("done-new", remote),
      member("failed"),
      member("awaiting"),
    ]);
    const { sections } = deriveSuperThreadSections([
      header,
      shell("working", working),
      shell("done-old", done(2)),
      shell("asking", asking),
      shell("done-new", done(9), remote),
      shell("failed", { latestRunId: RunId.make("run-f"), status: "failed" }),
      shell("awaiting", {
        ...done(8),
        status: "idle",
        pendingBackgroundTasks: [{ kind: "command", taskId: "watch", awaited: true }],
      }),
    ]);
    expect(idsOf(sections[0]!.rows)).toEqual([
      "asking",
      "failed",
      "awaiting",
      "working",
      "done-new",
      "done-old",
    ]);
  });

  it("gives a member listed by two super threads to the older one", () => {
    const older = superShell("older", [member("shared")], { createdAt: at(1) });
    const newer = superShell("newer", [member("shared")], { createdAt: at(2) });
    const shared = shell("shared", done(3));
    for (const shells of [
      [older, newer, shared],
      [shared, newer, older],
    ]) {
      const { sections } = deriveSuperThreadSections(shells);
      const rowsByHeader = Object.fromEntries(
        sections.map((section) => [section.header.id, idsOf(section.rows)]),
      );
      expect(rowsByHeader).toEqual({ older: ["shared"], newer: [] });
    }
  });
});

describe("planSuperThreadSettle", () => {
  it("settles the header and held unsettled members with the run ids it saw, warning on busy members", () => {
    const header = superShell(
      "super",
      [
        member("idle"),
        member("busy"),
        member("asking", remote),
        member("done"),
        member("gone", remote),
      ],
      done(1),
    );
    const plan = planSuperThreadSettle(
      header,
      [
        header,
        shell("idle"),
        shell("busy", working),
        shell("asking", asking, remote),
        shell("done", { ...done(2), ...settled }),
      ],
      new Set([local, remote]),
    );
    expect(plan.settles).toEqual([
      { ref: scopeThreadRef(local, ThreadId.make("super")), expectedLatestRunId: "run-1" },
      { ref: scopeThreadRef(local, ThreadId.make("idle")), expectedLatestRunId: null },
      { ref: scopeThreadRef(local, ThreadId.make("busy")), expectedLatestRunId: "run-w" },
      { ref: scopeThreadRef(remote, ThreadId.make("asking")), expectedLatestRunId: null },
    ]);
    expect(plan.warnings).toEqual([
      { ref: scopeThreadRef(local, ThreadId.make("busy")), reason: "running" },
      { ref: scopeThreadRef(remote, ThreadId.make("asking")), reason: "needs-input" },
      { ref: scopeThreadRef(remote, ThreadId.make("gone")), reason: "unreachable" },
    ]);
  });

  it("guards an already settled header too, and warns about and skips unreachable members", () => {
    const header = superShell("super", [member("a", remote)], settled);
    const plan = planSuperThreadSettle(header, [header, shell("a", {}, remote)], new Set([local]));
    expect(plan.settles).toEqual([
      { ref: scopeThreadRef(local, ThreadId.make("super")), expectedLatestRunId: null },
    ]);
    expect(plan.warnings).toEqual([
      { ref: scopeThreadRef(remote, ThreadId.make("a")), reason: "unreachable" },
    ]);
  });
});
