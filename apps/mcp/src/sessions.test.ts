import {
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findSessions } from "./sessions.ts";
import { at, NOW, thread } from "./testing.ts";

const project = (id: string, title: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `/src/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: at(0),
  updatedAt: at(0),
});

function session(
  id: string,
  title: string,
  updatedSecond: number,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  const { messages: _messages, activities: _activities, ...detail } = thread();
  return {
    ...detail,
    id: ThreadId.make(id),
    title,
    latestTurn: { ...detail.latestTurn!, state: "completed", completedAt: at(updatedSecond) },
    session: null,
    updatedAt: at(updatedSecond),
    latestUserMessageAt: at(1),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const shell = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [...projects],
  threads: [...threads],
  updatedAt: at(0),
});

const t3code = project("project-1", "t3code");
const dotfiles = project("project-2", "dotfiles");
const home = shell(
  [t3code, dotfiles],
  [
    session("flaky", "Fix the flaky test", 5),
    session("waiting", "Bump the nix flake", 9, {
      projectId: dotfiles.id,
      hasPendingApprovals: true,
    }),
    session("cjk", "修复测试超时", 7),
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
      latestTurn: thread().latestTurn,
    }),
  ],
);
const servers = [
  { serverId: "home", shell: home },
  { serverId: "work", shell: work },
];

describe("findSessions", () => {
  it("lists the most recently active sessions first across servers, with their state", () => {
    const listed = findSessions(servers, { limit: 3, now: NOW });
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
    expect(listed.sessions[0]?.reasoning_effort).toBeNull();
    expect(listed.more_sessions).toBe(1);
  });

  it("narrows by project and by every word of the query", () => {
    const ids = (filter: { readonly projectId?: string; readonly query?: string }) =>
      findSessions(servers, { ...filter, limit: 10, now: NOW }).sessions.map(
        (listed) => listed.session_id,
      );
    expect(ids({ query: "flaky TEST." })).toEqual(["flaky"]);
    expect(ids({ query: "flaky" })).toEqual(["running", "flaky"]);
    expect(ids({ query: "测试" })).toEqual(["cjk"]);
    expect(ids({ projectId: dotfiles.id })).toEqual(["waiting"]);
    expect(ids({ projectId: t3code.id, query: "nix" })).toEqual([]);
  });
});
