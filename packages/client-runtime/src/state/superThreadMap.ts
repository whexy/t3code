import type {
  SuperThreadMap,
  SuperThreadMapChange,
  SuperThreadMapEdgeKind,
  SuperThreadMapNode,
  SuperThreadMapNodeStatus,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./models.ts";
import { superThreadMemberIsWorking, superThreadMemberNeedsInput } from "./superThreads.ts";

export type SuperThreadMapNodeState =
  | "needs-you"
  | "failed"
  | "dropped"
  | "working"
  | "blocked"
  | "done"
  | "active"
  | "planned";

export const SUPER_THREAD_MAP_STATE_LABELS: Record<SuperThreadMapNodeState, string> = {
  "needs-you": "Needs you",
  failed: "Failed",
  dropped: "Dropped",
  working: "Working",
  blocked: "Blocked",
  done: "Done",
  active: "Active",
  planned: "Planned",
};

type LinkedThread = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "pendingBackgroundTasks"
  | "runtime"
  | "latestRun"
  | "settledOverride"
>;

const finished = (thread: LinkedThread) =>
  thread.settledOverride === "settled" || thread.latestRun?.status === "completed";

/**
 * What a node shows. Linked threads report what is happening and outrank the agent, which
 * only reports what threads can't: planned, blocked, done and dropped work. `null` is a linked
 * thread this client can't read.
 */
export function resolveSuperThreadMapNodeState(
  status: SuperThreadMapNodeStatus,
  threads: ReadonlyArray<LinkedThread | null>,
): { readonly state: SuperThreadMapNodeState; readonly unreachable: boolean } {
  const known = threads.filter((thread) => thread !== null);
  const unreachable = known.length < threads.length;
  const state = ((): SuperThreadMapNodeState => {
    if (known.some(superThreadMemberNeedsInput)) return "needs-you";
    if (known.some((thread) => thread.runtime?.status === "failed")) return "failed";
    if (status === "dropped") return "dropped";
    if (known.some(superThreadMemberIsWorking)) return "working";
    if (status === "blocked") return "blocked";
    if (status === "done") return "done";
    if (known.length > 0 && !unreachable && known.every(finished)) return "done";
    return status;
  })();
  return { state, unreachable };
}

const SUPER_THREAD_MAP_NODE_WIDTH = 220;
export const SUPER_THREAD_MAP_NODE_HEIGHT = 64;
/** How far a label beside a side bend may run, in px. */
export const SUPER_THREAD_MAP_SIDE_LABEL_WIDTH = 180;

/** Sizes the layout works in; a client picks smaller ones to fit a narrow screen. */
export interface SuperThreadMapMetrics {
  /** A node's width, and the most it gets when fitting `availableWidth`. */
  readonly nodeWidth: number;
  /** The least a node narrows to when fitting `availableWidth`. */
  readonly minNodeWidth: number;
  readonly nodeHeight: number;
  readonly columnGap: number;
  readonly rowGap: number;
  readonly laneGap: number;
  readonly laneHeader: number;
  readonly lanePadding: number;
  readonly margin: number;
  /** How far an edge between two nodes of one column bends out beside them. */
  readonly sideBend: number;
  /** Room kept for a label beside such a bend; 0 when the client doesn't draw edge labels. */
  readonly sideLabelWidth: number;
}

export const SUPER_THREAD_MAP_METRICS: SuperThreadMapMetrics = {
  nodeWidth: SUPER_THREAD_MAP_NODE_WIDTH,
  minNodeWidth: 176,
  nodeHeight: SUPER_THREAD_MAP_NODE_HEIGHT,
  columnGap: 72,
  rowGap: 14,
  laneGap: 16,
  laneHeader: 26,
  lanePadding: 12,
  margin: 8,
  sideBend: 40,
  sideLabelWidth: SUPER_THREAD_MAP_SIDE_LABEL_WIDTH,
};

export interface SuperThreadMapLayoutNode {
  readonly node: SuperThreadMapNode;
  readonly x: number;
  readonly y: number;
}

export interface SuperThreadMapLayoutLane {
  readonly group: string | null;
  readonly y: number;
  readonly height: number;
}

export interface SuperThreadMapLayoutEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: SuperThreadMapEdgeKind;
  readonly label: string | undefined;
  /** An SVG path in layout coordinates. */
  readonly path: string;
  /** The path's midpoint. */
  readonly labelX: number;
  readonly labelY: number;
  /**
   * "side": the edge joins two nodes of one column and bends out between them, so a label
   * centred on the midpoint covers the line; start it just right of labelX instead.
   */
  readonly labelAnchor: "center" | "side";
}

export interface SuperThreadMapLayout {
  readonly metrics: SuperThreadMapMetrics;
  readonly width: number;
  readonly height: number;
  readonly nodeWidth: number;
  readonly lanes: ReadonlyArray<SuperThreadMapLayoutLane>;
  /** In reading order: lane by lane, then column by column, top to bottom. */
  readonly nodes: ReadonlyArray<SuperThreadMapLayoutNode>;
  readonly edges: ReadonlyArray<SuperThreadMapLayoutEdge>;
}

/** Columns from the longest `depends` path; an edge that closes a cycle is ignored. */
function rankNodes(map: Pick<SuperThreadMap, "nodes" | "edges">): Map<string, number> {
  const predecessors = new Map<string, Array<string>>(map.nodes.map((node) => [node.id, []]));
  for (const edge of map.edges) {
    if (edge.kind === "depends") predecessors.get(edge.to)?.push(edge.from);
  }
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    let column = 0;
    for (const from of predecessors.get(id) ?? []) {
      if (visiting.has(from) || !predecessors.has(from)) continue;
      column = Math.max(column, visit(from) + 1);
    }
    visiting.delete(id);
    rank.set(id, column);
    return column;
  };
  for (const node of map.nodes) visit(node.id);
  return rank;
}

function edgePath(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  w: number,
  metrics: SuperThreadMapMetrics,
) {
  const midY = metrics.nodeHeight / 2;
  let start: readonly [number, number];
  let end: readonly [number, number];
  let c1: readonly [number, number];
  let c2: readonly [number, number];
  if (to.x > from.x) {
    start = [from.x + w, from.y + midY];
    end = [to.x, to.y + midY];
    const bend = Math.max(24, (end[0] - start[0]) / 2);
    c1 = [start[0] + bend, start[1]];
    c2 = [end[0] - bend, end[1]];
  } else if (to.x === from.x) {
    start = [from.x + w, from.y + midY];
    end = [to.x + w, to.y + midY];
    c1 = [start[0] + metrics.sideBend, start[1]];
    c2 = [end[0] + metrics.sideBend, end[1]];
  } else {
    start = [from.x, from.y + midY];
    end = [to.x + w, to.y + midY];
    c1 = [start[0] - metrics.sideBend, start[1]];
    c2 = [end[0] + metrics.sideBend, end[1]];
  }
  const path = `M${start[0]},${start[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${end[0]},${end[1]}`;
  return {
    path,
    labelX: (start[0] + 3 * c1[0] + 3 * c2[0] + end[0]) / 8,
    labelY: (start[1] + 3 * c1[1] + 3 * c2[1] + end[1]) / 8,
    labelAnchor: to.x === from.x ? ("side" as const) : ("center" as const),
  };
}

/**
 * Lays the map out left to right in one lane per group. It reads only ids, groups and edges,
 * so a status change never moves a node. Given `availableWidth`, nodes narrow down to a
 * readable minimum so the map fits without scrolling sideways.
 */
export function layoutSuperThreadMap(
  map: Pick<SuperThreadMap, "nodes" | "edges">,
  options: {
    readonly availableWidth?: number;
    readonly metrics?: SuperThreadMapMetrics;
  } = {},
): SuperThreadMapLayout {
  const metrics = options.metrics ?? SUPER_THREAD_MAP_METRICS;
  const { columnGap, laneGap, laneHeader, lanePadding, margin } = metrics;
  const rowPitch = metrics.nodeHeight + metrics.rowGap;
  const rank = rankNodes(map);
  const order = new Map(map.nodes.map((node, index) => [node.id, index]));
  const laneKeys: Array<string | null> = [];
  if (map.nodes.some((node) => node.group === undefined)) laneKeys.push(null);
  for (const node of map.nodes) {
    if (node.group !== undefined && !laneKeys.includes(node.group)) laneKeys.push(node.group);
  }
  const predecessors = new Map<string, Array<string>>();
  for (const edge of map.edges) {
    if (edge.kind !== "depends") continue;
    predecessors.set(edge.to, [...(predecessors.get(edge.to) ?? []), edge.from]);
  }
  const columns = Math.max(0, ...rank.values()) + 1;
  // An edge within the last column bends out past it, with its label beside the bend.
  const bendsOut = map.edges.filter(
    (edge) => rank.get(edge.from) === columns - 1 && rank.get(edge.to) === columns - 1,
  );
  const outerRoom = bendsOut.some((edge) => edge.label !== undefined)
    ? metrics.sideBend + 12 + metrics.sideLabelWidth
    : bendsOut.length > 0
      ? 48
      : 0;
  const fixedWidth = margin * 2 + lanePadding * 2 + (columns - 1) * columnGap + outerRoom;
  const nodeWidth =
    options.availableWidth === undefined
      ? metrics.nodeWidth
      : Math.min(
          metrics.nodeWidth,
          Math.max(
            metrics.minNodeWidth,
            Math.floor((options.availableWidth - fixedWidth) / columns),
          ),
        );
  const position = new Map<string, { x: number; y: number }>();
  const laidOut: Array<SuperThreadMapLayoutNode> = [];
  const lanes: Array<SuperThreadMapLayoutLane> = [];
  const labelled = laneKeys.some((key) => key !== null);
  let laneTop = margin;
  for (const group of laneKeys) {
    const inLane = map.nodes.filter((node) => (node.group ?? null) === group);
    const top = laneTop + (labelled ? laneHeader : lanePadding);
    let rows = 0;
    for (let column = 0; column < columns; column++) {
      const cell = inLane.filter((node) => rank.get(node.id) === column);
      // Barycenter of placed predecessors; a node without any keeps its own order.
      const key = (node: SuperThreadMapNode, fallbackRow: number) => {
        const ys = (predecessors.get(node.id) ?? []).flatMap((id) => {
          const placed = position.get(id);
          return placed === undefined ? [] : [placed.y];
        });
        return ys.length > 0
          ? ys.reduce((sum, y) => sum + y, 0) / ys.length
          : top + fallbackRow * rowPitch;
      };
      const sorted = cell
        .map((node, index) => ({ node, key: key(node, index) }))
        .sort((a, b) => a.key - b.key || order.get(a.node.id)! - order.get(b.node.id)!);
      sorted.forEach(({ node }, row) => {
        const placed = {
          x: margin + lanePadding + column * (nodeWidth + columnGap),
          y: top + row * rowPitch,
        };
        position.set(node.id, placed);
        laidOut.push({ node, ...placed });
      });
      rows = Math.max(rows, cell.length);
    }
    const height =
      (labelled ? laneHeader : lanePadding) + rows * rowPitch - metrics.rowGap + lanePadding;
    lanes.push({ group, y: laneTop, height });
    laneTop += height + laneGap;
  }
  const edges = map.edges.flatMap((edge): Array<SuperThreadMapLayoutEdge> => {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (from === undefined || to === undefined) return [];
    return [
      {
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        label: edge.label,
        ...edgePath(from, to, nodeWidth, metrics),
      },
    ];
  });
  return {
    metrics,
    width: fixedWidth + columns * nodeWidth,
    nodeWidth,
    height: laneTop - laneGap + margin,
    lanes,
    nodes: laidOut,
    edges,
  };
}

export interface SuperThreadMapChangesSince {
  readonly changes: ReadonlyArray<SuperThreadMapChange>;
  /** Nodes added since and still on the map. */
  readonly addedNodeIds: ReadonlySet<string>;
}

const NO_CHANGES: SuperThreadMapChangesSince = { changes: [], addedNodeIds: new Set() };

/** The agent's revisions after a person last looked; with no earlier look, nothing is news. */
export function superThreadMapChangesSince(
  map: Pick<SuperThreadMap, "nodes" | "changes">,
  seenAt: string | null | undefined,
): SuperThreadMapChangesSince {
  if (seenAt == null) return NO_CHANGES;
  const seen = Date.parse(seenAt);
  if (Number.isNaN(seen)) return NO_CHANGES;
  const changes = map.changes.filter((change) => Date.parse(change.at) > seen);
  if (changes.length === 0) return NO_CHANGES;
  const onMap = new Set(map.nodes.map((node) => node.id));
  return {
    changes,
    addedNodeIds: new Set(changes.flatMap((change) => change.added).filter((id) => onMap.has(id))),
  };
}
