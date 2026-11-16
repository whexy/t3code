import type { SuperThreadMap, SuperThreadMapNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  layoutSuperThreadMap,
  resolveSuperThreadMapNodeState,
  superThreadMapChangesSince,
} from "./superThreadMap.ts";

type Linked = Parameters<typeof resolveSuperThreadMapNodeState>[1][number];

const thread = (overrides: Partial<NonNullable<Linked>> = {}): NonNullable<Linked> => ({
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  pendingGuestMessageCount: 0,
  pendingBackgroundTasks: [],
  runtime: null,
  latestRun: null,
  settledOverride: null,
  ...overrides,
});
const runtime = (status: "running" | "failed" | "idle") =>
  ({ status, activeRunId: null }) as unknown as NonNullable<Linked>["runtime"];

describe("resolveSuperThreadMapNodeState", () => {
  const running = thread({ runtime: runtime("running") });
  const asking = thread({ hasPendingUserInput: true, runtime: runtime("running") });
  const failed = thread({ runtime: runtime("failed") });
  const finished = thread({
    runtime: runtime("idle"),
    latestRun: { status: "completed" } as NonNullable<Linked>["latestRun"],
  });
  const awaitingOwnWork = thread({
    ...finished,
    pendingBackgroundTasks: [
      { kind: "command", taskId: "tlc", awaited: true },
    ] as NonNullable<Linked>["pendingBackgroundTasks"],
  });
  const notStarted = thread({ runtime: runtime("idle") });
  const settled = thread({ settledOverride: "settled" });

  it.each([
    ["a thread waiting for the person outranks everything", "done", [running, asking], "needs-you"],
    ["a failed thread outranks the agent's word", "dropped", [failed], "failed"],
    ["dropped outranks a thread still running", "dropped", [running], "dropped"],
    ["a running thread outranks blocked and done", "done", [running], "working"],
    [
      "a thread awaiting its own background work is still working",
      "active",
      [awaitingOwnWork, settled],
      "working",
    ],
    ["the agent's blocked shows once threads stop", "blocked", [finished], "blocked"],
    ["the agent's done shows once threads stop", "done", [finished], "done"],
    ["every linked thread finished reads as done", "active", [finished, settled], "done"],
    ["a thread that hasn't run yet keeps the agent's status", "active", [notStarted], "active"],
    ["a node without threads shows the agent's status", "active", [], "active"],
    ["a node without threads shows the agent's status", "planned", [], "planned"],
  ] as const)("%s", (_name, status, threads, expected) => {
    expect(resolveSuperThreadMapNodeState(status, threads).state).toBe(expected);
  });

  it("marks a node whose thread this client can't read, and never calls it done", () => {
    expect(resolveSuperThreadMapNodeState("active", [settled, null])).toEqual({
      state: "active",
      unreachable: true,
    });
  });
});

const node = (id: string, group?: string): SuperThreadMapNode => ({
  id,
  title: id,
  status: "planned",
  ...(group === undefined ? {} : { group }),
});

describe("layoutSuperThreadMap", () => {
  const map: Pick<SuperThreadMap, "nodes" | "edges"> = {
    nodes: [node("rgw", "ceph"), node("fs", "ceph"), node("wdl", "apps"), node("ota", "apps")],
    edges: [
      { from: "rgw", to: "wdl", kind: "depends" },
      { from: "fs", to: "ota", kind: "depends" },
      { from: "rgw", to: "ota", kind: "depends" },
      { from: "wdl", to: "ota", kind: "relates", label: "same bucket" },
    ],
  };
  const where = (layout: ReturnType<typeof layoutSuperThreadMap>) =>
    Object.fromEntries(layout.nodes.map(({ node, x, y }) => [node.id, [x, y]]));

  it("puts a node right of what it depends on, one lane per group", () => {
    const layout = layoutSuperThreadMap(map);
    const at = where(layout);
    expect(at.wdl![0]).toBeGreaterThan(at.rgw![0]!);
    expect(at.ota![0]).toBe(at.wdl![0]);
    expect(at.rgw![0]).toBe(at.fs![0]);
    expect(layout.lanes.map((lane) => lane.group)).toEqual(["ceph", "apps"]);
    const [ceph, apps] = layout.lanes;
    for (const id of ["rgw", "fs"]) {
      expect(at[id]![1]).toBeGreaterThanOrEqual(ceph!.y);
      expect(at[id]![1]).toBeLessThan(ceph!.y + ceph!.height);
    }
    expect(apps!.y).toBeGreaterThanOrEqual(ceph!.y + ceph!.height);
    expect(layout.edges.map((edge) => edge.label)).toContain("same bucket");
  });

  it("keeps every position when only statuses and text change", () => {
    const changed = {
      ...map,
      nodes: map.nodes.map((n) => ({ ...n, status: "done" as const, title: `${n.id}!` })),
    };
    expect(where(layoutSuperThreadMap(changed))).toEqual(where(layoutSuperThreadMap(map)));
  });

  it("lays out a dependency cycle instead of looping", () => {
    const layout = layoutSuperThreadMap({
      nodes: [node("a"), node("b")],
      edges: [
        { from: "a", to: "b", kind: "depends" },
        { from: "b", to: "a", kind: "depends" },
      ],
    });
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(2);
  });
});

describe("superThreadMapChangesSince", () => {
  const map: Pick<SuperThreadMap, "nodes" | "changes"> = {
    nodes: [node("a"), node("c")],
    changes: [
      {
        revision: 1,
        reason: "Plan",
        at: "2026-11-16T10:00:00.000Z",
        added: ["a", "b"],
        removed: [],
      },
      {
        revision: 2,
        reason: "Swap b for c",
        at: "2026-11-16T11:00:00.000Z",
        added: ["c"],
        removed: [{ id: "b", title: "b" }],
      },
    ],
  };

  it("lists revisions after the last look and the nodes they added that remain", () => {
    const since = superThreadMapChangesSince(map, "2026-11-16T10:30:00.000Z");
    expect(since.changes.map((change) => change.revision)).toEqual([2]);
    expect([...since.addedNodeIds]).toEqual(["c"]);
  });

  it("calls nothing new for a person who never looked", () => {
    expect(superThreadMapChangesSince(map, null).changes).toEqual([]);
  });
});
