import {
  SUPER_THREAD_MAP_MAX_CHANGES,
  SUPER_THREAD_MAP_MAX_EDGES,
  SUPER_THREAD_MAP_MAX_NODES,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShell,
  type SuperThreadInternalCommand,
  type SuperThreadLaunchKey,
  type SuperThreadMap,
  type SuperThreadMapEdgeRef,
  type SuperThreadMapUpdate,
  type SuperThreadMember,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/** Followed runs beyond this drop the oldest, so an unreachable environment cannot grow the list. */
const SUPER_THREAD_MAX_FOLLOWING = 50;

export const isSameMember = (left: SuperThreadMember, right: SuperThreadMember) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

/** The thread a super thread command leaves, or why it refuses. */
export function applySuperThreadCommand(
  thread: OrchestrationV2AppThread,
  command: Exclude<SuperThreadInternalCommand, { readonly type: "super_thread.member.wake" }>,
  now: DateTime.Utc,
): OrchestrationV2AppThread | { readonly refused: string } {
  const state = thread.superThread;
  if (state === undefined) return { refused: `Thread ${thread.id} is not a super thread.` };
  if (thread.deletedAt !== null) return { refused: `Thread ${thread.id} is deleted.` };
  switch (command.type) {
    case "super_thread.member.record": {
      const { environmentId, threadId } = command.member;
      const listed = state.members.some((member) =>
        isSameMember(member, { environmentId, threadId }),
      );
      const recorded = listed ? state : { ...state, members: [...state.members, command.member] };
      return {
        ...thread,
        superThread: command.launch ? withoutLaunch(recorded, command.launch) : recorded,
      };
    }
    case "super_thread.member.follow": {
      const { run } = command;
      if (!state.members.some((member) => isSameMember(member, run))) {
        return { refused: `Thread ${run.threadId} is not a member of ${thread.id}.` };
      }
      const following = state.following ?? [];
      if (following.some((entry) => isSameMember(entry, run) && entry.runId === run.runId)) {
        return thread;
      }
      return {
        ...thread,
        superThread: {
          ...state,
          following: [...following, run].slice(-SUPER_THREAD_MAX_FOLLOWING),
        },
      };
    }
    case "super_thread.launch.pending":
      return {
        ...thread,
        superThread: {
          ...state,
          pendingLaunches: [
            ...(withoutLaunch(state, command.launch).pendingLaunches ?? []),
            command.launch,
          ],
        },
      };
    case "super_thread.launch.end":
      return { ...thread, superThread: withoutLaunch(state, command.launch) };
    case "super_thread.map.update": {
      const map = applySuperThreadMapUpdate(
        state.map,
        state.members,
        command.update,
        DateTime.formatIso(now),
      );
      return "refused" in map ? map : { ...thread, superThread: { ...state, map } };
    }
  }
}

const sameLaunch = (a: SuperThreadLaunchKey, b: SuperThreadLaunchKey) =>
  a.environmentId === b.environmentId &&
  a.requestNamespace === b.requestNamespace &&
  a.clientRequestId === b.clientRequestId;

/** Leaves the key out rather than empty, so a super thread with nothing pending stores nothing. */
const withoutLaunch = (
  state: NonNullable<OrchestrationV2AppThread["superThread"]>,
  launch: SuperThreadLaunchKey,
): NonNullable<OrchestrationV2AppThread["superThread"]> => {
  const { pendingLaunches, ...rest } = state;
  const left = (pendingLaunches ?? []).filter((pending) => !sameLaunch(pending, launch));
  return left.length === 0 ? rest : { ...rest, pendingLaunches: left };
};

const edgeKey = (edge: SuperThreadMapEdgeRef) => JSON.stringify([edge.from, edge.to]);
const memberKey = (member: SuperThreadMember) =>
  JSON.stringify([member.environmentId, member.threadId]);

/** Applies one agent patch: upserts keep their node's place, and removing a node removes its edges. */
export function applySuperThreadMapUpdate(
  current: SuperThreadMap | undefined,
  members: ReadonlyArray<SuperThreadMember>,
  update: SuperThreadMapUpdate,
  at: string,
): SuperThreadMap | { readonly refused: string } {
  const base = update.reset === true ? undefined : current;
  const nodes = new Map((base?.nodes ?? []).map((node) => [node.id, node]));
  const removed: Array<{ id: string; title: string }> = [];
  for (const id of update.removeNodes ?? []) {
    const node = nodes.get(id);
    if (node === undefined) continue;
    nodes.delete(id);
    removed.push({ id, title: node.title });
  }
  const added: Array<string> = [];
  for (const node of update.upsertNodes ?? []) {
    if (!nodes.has(node.id)) added.push(node.id);
    nodes.set(node.id, node);
  }
  if (nodes.size > SUPER_THREAD_MAP_MAX_NODES) {
    return { refused: `A map holds at most ${SUPER_THREAD_MAP_MAX_NODES} nodes.` };
  }
  const memberKeys = new Set(members.map(memberKey));
  for (const node of nodes.values()) {
    const stranger = node.threads?.find((thread) => !memberKeys.has(memberKey(thread)));
    if (stranger !== undefined) {
      return {
        refused: `Node "${node.id}" links thread ${stranger.threadId}, which this super thread did not launch.`,
      };
    }
  }

  const edges = new Map((base?.edges ?? []).map((edge) => [edgeKey(edge), edge]));
  for (const edge of update.removeEdges ?? []) edges.delete(edgeKey(edge));
  for (const edge of update.upsertEdges ?? []) {
    if (edge.from === edge.to)
      return { refused: `Edge ${edge.from} → ${edge.to} links a node to itself.` };
    edges.set(edgeKey(edge), edge);
  }
  for (const edge of edges.values()) {
    const missing = [edge.from, edge.to].find((id) => !nodes.has(id));
    if (missing === undefined) continue;
    // An edge the patch names is a mistake; an older edge simply goes with its removed node.
    if ((update.upsertEdges ?? []).some((named) => edgeKey(named) === edgeKey(edge))) {
      return {
        refused: `Edge ${edge.from} → ${edge.to} names node "${missing}", which is not on the map.`,
      };
    }
    edges.delete(edgeKey(edge));
  }
  if (edges.size > SUPER_THREAD_MAP_MAX_EDGES) {
    return { refused: `A map holds at most ${SUPER_THREAD_MAP_MAX_EDGES} edges.` };
  }

  const revision = (current?.revision ?? 0) + 1;
  return {
    goal: update.goal ?? base?.goal ?? "",
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    revision,
    updatedAt: at,
    changes: [
      ...(base?.changes ?? []),
      {
        revision,
        reason: update.reason,
        at,
        added: added.filter((id) => nodes.has(id)),
        removed: removed.filter(({ id }) => !nodes.has(id)),
      },
    ].slice(-SUPER_THREAD_MAP_MAX_CHANGES),
  };
}

/**
 * `thread.tags-updated` replaces the thread record without counting as activity or alerting, and
 * every client already decodes it; a new event type would break clients older than this server.
 */
export const superThreadUpdatedEvent = (
  thread: OrchestrationV2AppThread,
  occurredAt: DateTime.Utc,
) => ({
  type: "thread.tags-updated" as const,
  threadId: thread.id,
  providerInstanceId: thread.providerInstanceId,
  occurredAt,
  payload: thread,
});

/** The shell streams on every thread change, so it leaves the map to thread detail. */
export const superThreadShellFields = (
  thread: OrchestrationV2AppThread,
): Pick<OrchestrationV2ThreadShell, "superThread"> =>
  thread.superThread === undefined ? {} : { superThread: { members: thread.superThread.members } };

/** Whether a thread's MCP session should see the super thread tools; a failed read hides them. */
export const isSuperThread = <E, R>(
  projectionStore: {
    readonly getThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread, E, R>;
  },
  threadId: ThreadId,
) =>
  projectionStore.getThread(threadId).pipe(
    Effect.map((thread) => thread.superThread !== undefined),
    Effect.orElseSucceed(() => false),
  );
