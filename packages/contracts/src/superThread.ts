import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** A thread the super thread launched, possibly in a linked environment. */
export const SuperThreadMember = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type SuperThreadMember = typeof SuperThreadMember.Type;

const MapNodeId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/** What the agent says about a node; a linked thread's own state outranks it in clients. */
export const SuperThreadMapNodeStatus = Schema.Literals([
  "planned",
  "active",
  "blocked",
  "done",
  "dropped",
]);
export type SuperThreadMapNodeStatus = typeof SuperThreadMapNodeStatus.Type;

export const SuperThreadMapNode = Schema.Struct({
  id: MapNodeId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  /** Purpose, boundaries and what counts as done. */
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  /** The current remark, such as why the node is blocked. */
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  /** Nodes sharing a group are drawn in one lane. */
  group: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  status: SuperThreadMapNodeStatus,
  /** Members of this super thread doing the work. */
  threads: Schema.optional(Schema.Array(SuperThreadMember).check(Schema.isMaxLength(8))),
});
export type SuperThreadMapNode = typeof SuperThreadMapNode.Type;

/** `depends`: `to` waits for `from`, and sets the left-to-right order. `relates` only links. */
export const SuperThreadMapEdgeKind = Schema.Literals(["depends", "relates"]);
export type SuperThreadMapEdgeKind = typeof SuperThreadMapEdgeKind.Type;

export const SuperThreadMapEdgeRef = Schema.Struct({ from: MapNodeId, to: MapNodeId });
export type SuperThreadMapEdgeRef = typeof SuperThreadMapEdgeRef.Type;

export const SuperThreadMapEdge = Schema.Struct({
  ...SuperThreadMapEdgeRef.fields,
  kind: SuperThreadMapEdgeKind,
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(60))),
});
export type SuperThreadMapEdge = typeof SuperThreadMapEdge.Type;

export const SUPER_THREAD_MAP_MAX_NODES = 100;
export const SUPER_THREAD_MAP_MAX_EDGES = 200;
export const SUPER_THREAD_MAP_MAX_CHANGES = 20;

/** One agent write, kept so clients can say what changed since a person last looked. */
export const SuperThreadMapChange = Schema.Struct({
  revision: Schema.Int,
  reason: Schema.String,
  /** A string like the thread's other nested times, since the stored thread JSON maps only its own. */
  at: IsoDateTime,
  added: Schema.Array(MapNodeId),
  removed: Schema.Array(Schema.Struct({ id: MapNodeId, title: Schema.String })),
});
export type SuperThreadMapChange = typeof SuperThreadMapChange.Type;

/** Written only by the super agent; read-only for people. */
export const SuperThreadMap = Schema.Struct({
  goal: Schema.String.check(Schema.isMaxLength(4000)),
  nodes: Schema.Array(SuperThreadMapNode).check(Schema.isMaxLength(SUPER_THREAD_MAP_MAX_NODES)),
  edges: Schema.Array(SuperThreadMapEdge).check(Schema.isMaxLength(SUPER_THREAD_MAP_MAX_EDGES)),
  revision: Schema.Int,
  updatedAt: IsoDateTime,
  changes: Schema.Array(SuperThreadMapChange),
});
export type SuperThreadMap = typeof SuperThreadMap.Type;

/** A patch from the super agent; ids not named keep their nodes and edges. */
export const SuperThreadMapUpdate = Schema.Struct({
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  goal: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  reset: Schema.optional(Schema.Boolean),
  upsertNodes: Schema.optional(
    Schema.Array(SuperThreadMapNode).check(Schema.isMaxLength(SUPER_THREAD_MAP_MAX_NODES)),
  ),
  removeNodes: Schema.optional(Schema.Array(MapNodeId)),
  upsertEdges: Schema.optional(
    Schema.Array(SuperThreadMapEdge).check(Schema.isMaxLength(SUPER_THREAD_MAP_MAX_EDGES)),
  ),
  removeEdges: Schema.optional(Schema.Array(SuperThreadMapEdgeRef)),
});
export type SuperThreadMapUpdate = typeof SuperThreadMapUpdate.Type;

/**
 * Present only on a super thread, fixed at creation. `members` is append-only and holds only
 * threads this thread launched itself, which is what keeps every thread in at most one group.
 */
export const SuperThreadState = Schema.Struct({
  members: Schema.Array(SuperThreadMember),
  /** Absent until the agent draws one. */
  map: Schema.optionalKey(SuperThreadMap),
});
export type SuperThreadState = typeof SuperThreadState.Type;

/** The shell streams on every thread change, so it carries members only; the map rides on thread detail. */
export const SuperThreadShellState = Schema.Struct({
  members: SuperThreadState.fields.members,
});
export type SuperThreadShellState = typeof SuperThreadShellState.Type;

/**
 * Server-only commands. Each refuses a thread that is not a super thread, and recording a member
 * already on the list changes nothing.
 */
export const SuperThreadInternalCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("super_thread.member.record"),
    commandId: CommandId,
    threadId: ThreadId,
    member: SuperThreadMember,
  }),
  Schema.Struct({
    type: Schema.Literal("super_thread.map.update"),
    commandId: CommandId,
    threadId: ThreadId,
    update: SuperThreadMapUpdate,
  }),
]);
export type SuperThreadInternalCommand = typeof SuperThreadInternalCommand.Type;
