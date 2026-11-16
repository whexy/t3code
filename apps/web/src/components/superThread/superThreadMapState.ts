import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveSuperThreadMapNodeState,
  type SuperThreadMapNodeState,
} from "@t3tools/client-runtime/state/super-thread-map";
import type {
  EnvironmentId,
  SuperThreadMapNode,
  SuperThreadMapNodeStatus,
  SuperThreadMember,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleSlash2Icon,
  MessageCircleQuestionIcon,
  OctagonMinusIcon,
} from "lucide-react";

import { environmentThreadShells } from "../../state/threads";

/** Ordered by how much each state asks of the person. */
export const STATE_PRESENTATION: Record<
  SuperThreadMapNodeState,
  { readonly icon: typeof CircleIcon; readonly className: string }
> = {
  "needs-you": {
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  failed: { icon: CircleAlertIcon, className: "text-error-foreground" },
  blocked: { icon: OctagonMinusIcon, className: "text-warning-foreground" },
  working: { icon: CircleDashedIcon, className: "text-info-foreground" },
  active: { icon: CircleDotIcon, className: "text-info-foreground" },
  planned: { icon: CircleIcon, className: "text-muted-foreground" },
  done: { icon: CircleCheckIcon, className: "text-success-foreground" },
  dropped: { icon: CircleSlash2Icon, className: "text-muted-foreground" },
};

export const SUPER_THREAD_MAP_STATE_ORDER = Object.keys(
  STATE_PRESENTATION,
) as ReadonlyArray<SuperThreadMapNodeState>;

type ThreadPair = [EnvironmentId, ThreadId];

const refsOf = (pairs: ReadonlyArray<ThreadPair>) =>
  pairs.map(([environmentId, id]) =>
    environmentThreadShells.quietThreadShellAtom(scopeThreadRef(environmentId, id)),
  );

const pairsOf = (threads: ReadonlyArray<SuperThreadMember> | undefined) =>
  (threads ?? []).map((thread) => [thread.environmentId, thread.threadId]);

// One atom per node's thread list, so a thread's update repaints only the nodes that link it.
export const linkedShellsAtom = Atom.family((key: string) => {
  const shells = refsOf(JSON.parse(key) as Array<ThreadPair>);
  return Atom.make((get) => shells.map((shell) => get(shell)));
});

export const threadsKey = (threads: ReadonlyArray<SuperThreadMember> | undefined) =>
  JSON.stringify(pairsOf(threads));

/** How many nodes show each state, read the way the map's nodes read it. */
export const nodeStateCountsAtom = Atom.family((key: string) => {
  const nodes = (JSON.parse(key) as Array<[SuperThreadMapNodeStatus, Array<ThreadPair>]>).map(
    ([status, pairs]) => ({ status, shells: refsOf(pairs) }),
  );
  return Atom.make((get) => {
    const counts = new Map<SuperThreadMapNodeState, number>();
    for (const node of nodes) {
      const { state } = resolveSuperThreadMapNodeState(
        node.status,
        node.shells.map((shell) => get(shell)),
      );
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    return counts;
  });
});

export const nodeStatesKey = (nodes: ReadonlyArray<SuperThreadMapNode>) =>
  JSON.stringify(nodes.map((node) => [node.status, pairsOf(node.threads)]));
