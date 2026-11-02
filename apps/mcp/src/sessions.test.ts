import {
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { findSessions } from "./sessions.ts";
import { appThread, at } from "./testing.ts";

const utc = (second: number) => DateTime.makeUnsafe(at(second));

const project = (id: string, title: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `/src/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: at(0),
  updatedAt: at(0),
});

/** A session whose latest run completed at `updatedSecond`. */
function session(
  id: string,
  title: string,
  updatedSecond: number,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const thread = appThread({ id: ThreadId.make(id), title });
  return {
    ...thread,
    latestRunId: RunId.make(`${id}-run`),
    latestRunRequestedAt: utc(1),
    latestRunStartedAt: utc(2),
    latestRunCompletedAt: utc(updatedSecond),
    activeRunId: null,
    status: "completed",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: utc(1),
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 2,
    visibleItemCount: 2,
    updatedAt: utc(updatedSecond),
    ...overrides,
  };
}

const shell = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): OrchestrationV2ShellSnapshot => ({
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [...projects],
  threads: [...threads],
  archivedThreads: [],
});

const t3code = project("project-1", "t3code");
const dotfiles = project("project-2", "dotfiles");
const home = shell(
  [t3code, dotfiles],
  [
    session("flaky", "Fix the flaky test", 5),
    session("waiting", "Bump the nix flake", 9, {
      projectId: dotfiles.id,
      status: "waiting",
      activityRunStatus: "waiting",
      latestRunCompletedAt: null,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-1"),
        kind: "command",
        createdAt: utc(9),
      },
    }),
    session("cjk", "修复测试超时", 7),
    // Subagents are reached through their parent session, as in the sidebar.
    session("subagent", "Flaky test investigation", 10, {
      lineage: {
        parentThreadId: ThreadId.make("flaky"),
        relationshipToParent: "subagent",
        rootThreadId: ThreadId.make("flaky"),
      },
    }),
  ],
);
const work = shell(
  [project("project-3", "api")],
  [
    session("running", "Flaky CI on main", 8, {
      projectId: ProjectId.make("project-3"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "opus",
        options: [{ id: "effort", value: "max" }],
      },
      status: "running",
      activityRunStatus: "running",
      activeRunId: RunId.make("running-run"),
      latestRunCompletedAt: null,
    }),
  ],
);
const servers = [
  { serverId: "home", shell: home },
  { serverId: "work", shell: work },
];

describe("findSessions", () => {
  it("lists the most recently active sessions first across servers, with their state", () => {
    const listed = findSessions(servers, { limit: 3 });
    expect(
      listed.sessions.map(({ server_id, session_id, state }) => [server_id, session_id, state]),
    ).toEqual([
      ["home", "waiting", "waiting"],
      ["work", "running", "running"],
      ["home", "cjk", "completed"],
    ]);
    expect(listed.sessions[1]).toMatchObject({
      project_name: "api",
      agent: "claudeAgent",
      model: "opus",
      reasoning_effort: "max",
      created_at: at(1),
      updated_at: at(8),
      turn: { started_at: at(2), completed_at: null },
    });
    expect(listed.sessions[2]?.turn).toEqual({ started_at: at(2), completed_at: at(7) });
    expect(listed.sessions[0]?.reasoning_effort).toBeNull();
    expect(listed.more_sessions).toBe(1);
  });

  it("narrows by project and by every word of the query", () => {
    const ids = (filter: { readonly projectId?: string; readonly query?: string }) =>
      findSessions(servers, { ...filter, limit: 10 }).sessions.map((listed) => listed.session_id);
    expect(ids({ query: "flaky TEST." })).toEqual(["flaky"]);
    expect(ids({ query: "flaky" })).toEqual(["running", "flaky"]);
    expect(ids({ query: "测试" })).toEqual(["cjk"]);
    expect(ids({ projectId: dotfiles.id })).toEqual(["waiting"]);
    expect(ids({ projectId: t3code.id, query: "nix" })).toEqual([]);
  });

  it("reports how the last run ended once it has settled, and idle before any run", () => {
    const states = findSessions(
      [
        {
          serverId: "home",
          shell: shell(
            [t3code],
            [
              session("stopped", "Stopped", 4, { status: "interrupted" }),
              session("broken", "Broken", 3, { status: "failed" }),
              session("fresh", "Fresh", 2, {
                status: "idle",
                latestRunId: null,
                latestRunRequestedAt: null,
                latestRunStartedAt: null,
                latestRunCompletedAt: null,
              }),
            ],
          ),
        },
      ],
      { limit: 10 },
    ).sessions.map((listed) => [listed.session_id, listed.state, listed.turn]);
    expect(states).toEqual([
      ["stopped", "interrupted", { started_at: at(2), completed_at: at(4) }],
      ["broken", "failed", { started_at: at(2), completed_at: at(3) }],
      ["fresh", "idle", null],
    ]);
  });
});
