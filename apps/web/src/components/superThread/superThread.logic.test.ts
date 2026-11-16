import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { buildSuperThreadSettleConfirmation, deriveSuperThreadSidebar } from "./superThread.logic";

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
});

describe("buildSuperThreadSettleConfirmation", () => {
  const ref = (id: string, environmentId = local) =>
    scopeThreadRef(environmentId, ThreadId.make(id));
  const titles: Record<string, string> = { a: "Fix API", b: "Ship docs" };

  it("skips the confirmation when nothing is busy or out of reach", () => {
    expect(
      buildSuperThreadSettleConfirmation({
        title: "Release",
        warnings: [],
        memberSettleCount: 2,
        titleOf: () => null,
      }),
    ).toBeNull();
  });

  it("names busy members, warns that questions can be dismissed, and counts unreachable ones", () => {
    expect(
      buildSuperThreadSettleConfirmation({
        title: "Release",
        warnings: [
          { ref: ref("a"), reason: "running" },
          { ref: ref("b"), reason: "needs-input" },
          { ref: ref("c", remote), reason: "unreachable" },
        ],
        memberSettleCount: 2,
        titleOf: (target) => titles[target.threadId] ?? null,
      }),
    ).toBe(
      [
        'Settle "Release" and 2 threads it launched?',
        'Still working: "Fix API".',
        'Waiting for you: "Ship docs". Settling can dismiss their open questions.',
        "1 thread can't be reached right now and won't be settled.",
      ].join("\n"),
    );
  });
});
