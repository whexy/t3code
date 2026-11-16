import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  deriveSuperThreadSidebar,
  findSuperThreadSectionThread,
  resolveSuperThreadRowStatus,
} from "./superThread.logic";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");
const projectA = ProjectId.make("project-a");
const scratch = ProjectId.make("scratch");

function shell(
  id: string,
  projectId: ProjectId,
  environmentId = local,
  source: Partial<OrchestrationV2ThreadShell> = {},
) {
  const threadId = ThreadId.make(id);
  return presentThreadShell(environmentId, {
    ...makeThreadFixture().source,
    id: threadId,
    projectId,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    ...source,
  });
}

const header = shell("super", scratch, local, {
  superThread: {
    members: [
      { environmentId: local, threadId: ThreadId.make("a") },
      { environmentId: remote, threadId: ThreadId.make("b") },
    ],
  },
});
const memberA = shell("a", projectA);
const memberB = shell("b", projectA, remote);
const loose = shell("loose", projectA);
const threads = [header, memberA, memberB, loose];
const configs = (...ids: EnvironmentId[]) =>
  new Map(ids.map((id) => [id, {} as EnvironmentServerConfig] as const));

describe("deriveSuperThreadSidebar", () => {
  it.each([
    {
      name: "claims the header and the members of loaded environments",
      scope: null,
      loaded: [local],
      rows: ["a"],
      unclaimed: ["b", "loose"],
    },
    {
      name: "leaves members to the normal sections when the scope hides the header",
      scope: new Set([`${local}:${projectA}`, `${remote}:${projectA}`]),
      loaded: [local, remote],
      rows: null,
      unclaimed: ["super", "a", "b", "loose"],
    },
  ])("$name", ({ scope, loaded, rows, unclaimed }) => {
    const result = deriveSuperThreadSidebar({
      threads,
      scopedProjectKeys: scope,
      delegatedUnderParent: new Set(),
      serverConfigs: configs(...loaded),
    });
    expect(result.sections.map((section) => section.rows.map((row) => row.id))).toEqual(
      rows === null ? [] : [rows],
    );
    expect(result.unclaimedThreads.map((thread) => thread.id)).toEqual(unclaimed);
  });

  it("finds the header and the members it draws, for their context menus", () => {
    const { sections } = deriveSuperThreadSidebar({
      threads,
      scopedProjectKeys: null,
      delegatedUnderParent: new Set(),
      serverConfigs: configs(local),
    });
    const find = (thread: typeof header) =>
      findSuperThreadSectionThread(sections, `${thread.environmentId}:${thread.id}`)?.id;
    expect([find(header), find(memberA), find(loose)]).toEqual([header.id, memberA.id, undefined]);
  });
});

describe("resolveSuperThreadRowStatus", () => {
  const completed = {
    latestRunId: RunId.make("run-1"),
    status: "completed",
    latestRunCompletedAt: DateTime.makeUnsafe("2026-06-20T00:10:00.000Z"),
  } as const;
  it.each([
    {
      name: "a finished thread reads Done while unread",
      source: completed,
      unread: true,
      expected: "done",
    },
    {
      name: "a finished thread shows nothing once read",
      source: completed,
      unread: false,
      expected: null,
    },
    {
      name: "a starting thread reads Setting up",
      source: {
        latestRunId: RunId.make("run-2"),
        status: "preparing",
        activeRunId: RunId.make("run-2"),
      },
      unread: false,
      expected: "setting-up",
    },
  ] as const)("$name", ({ source, unread, expected }) => {
    expect(resolveSuperThreadRowStatus(shell("t", projectA, local, source), unread)).toBe(expected);
  });
});
