import { useAtomValue } from "@effect/atom-react";
import { SUPER_THREAD_MAP_STATE_LABELS } from "@t3tools/client-runtime/state/super-thread-map";
import type {
  ScopedThreadRef,
  SuperThreadMap as SuperThreadMapState,
  SuperThreadMapNode,
  SuperThreadMember,
} from "@t3tools/contracts";

import { TargetIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { SuperThreadMap } from "./SuperThreadMap";
import {
  nodeStateCountsAtom,
  nodeStatesKey,
  SUPER_THREAD_MAP_STATE_ORDER,
} from "./superThreadMapState";
import { SuperThreadMembers } from "./SuperThreadMembers";
import { SuperThreadPanelHeading } from "./SuperThreadPanelHeading";
import { useSuperThreadPanelLook } from "./superThreadPanelSeen";

function membersNotOnMap(
  members: ReadonlyArray<SuperThreadMember>,
  map: SuperThreadMapState,
): ReadonlyArray<SuperThreadMember> {
  const onMap = new Set(
    map.nodes.flatMap((node) =>
      (node.threads ?? []).map((thread) => `${thread.environmentId}\u0000${thread.threadId}`),
    ),
  );
  return members.filter((member) => !onMap.has(`${member.environmentId}\u0000${member.threadId}`));
}

function SuperThreadPanelSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-6 p-4 pt-3">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton shape="card" className="h-24 w-full" />
      </div>
    </div>
  );
}

// Clamped like a long message in the conversation, so the goal doesn't push the map down.
function SuperThreadGoal(props: { readonly goal: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  return (
    <div className="px-2.5 py-1">
      <p
        ref={(element) => {
          if (element !== null && !expanded) {
            setOverflows(element.scrollHeight > element.clientHeight + 1);
          }
        }}
        className={cn("text-sm whitespace-pre-wrap text-foreground", !expanded && "line-clamp-3")}
      >
        {props.goal}
      </p>
      {overflows ? (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="-ml-1.5 mt-0.5"
        >
          {expanded ? "Show less" : "Show full goal"}
        </Button>
      ) : null}
    </div>
  );
}

function SuperThreadMapFooter(props: { readonly nodes: ReadonlyArray<SuperThreadMapNode> }) {
  const counts = useAtomValue(nodeStateCountsAtom(nodeStatesKey(props.nodes)));
  const parts = [
    `${props.nodes.length} on the map`,
    ...SUPER_THREAD_MAP_STATE_ORDER.flatMap((state) => {
      const count = counts.get(state) ?? 0;
      return count > 0 ? [`${count} ${SUPER_THREAD_MAP_STATE_LABELS[state].toLowerCase()}`] : [];
    }),
  ];
  return (
    <footer className="border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
      {parts.join(" · ")}
    </footer>
  );
}

/** A super thread's goal, task map and threads, shown beside its conversation. */
export function SuperThreadPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  const { threadRef } = props;
  const shell = useQuietThreadShell(threadRef);
  const detail = useQuietThreadProjection(threadRef);
  const seenAt = useSuperThreadPanelLook(threadRef, props.visible);
  if (shell !== null && shell.source.superThread === undefined) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>Not a super thread</EmptyTitle>
          <EmptyDescription>Only a super thread has a goal and a task map.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (shell === null || detail === null) return <SuperThreadPanelSkeleton />;
  const superThread = detail.projection.thread.superThread;
  const members = superThread?.members ?? shell.source.superThread?.members ?? [];
  const map = superThread?.map ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Takes focus when the panel opens, so a map row's hover card doesn't open by itself. */}
      <div
        data-workspace-focus-default
        tabIndex={-1}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-1.5 pt-3 outline-none"
      >
        <section aria-label="Goal" className="space-y-0.5">
          <SuperThreadPanelHeading icon={TargetIcon} title="Goal" />
          {map !== null && map.goal.trim().length > 0 ? (
            <SuperThreadGoal goal={map.goal} />
          ) : (
            <p className="px-2.5 py-1 text-sm text-muted-foreground">
              No goal yet. The agent writes it once it has a plan.
            </p>
          )}
        </section>
        {map !== null ? <SuperThreadMap map={map} seenAt={seenAt} /> : null}
        <SuperThreadMembers
          members={map === null ? members : membersNotOnMap(members, map)}
          title={map === null ? "Threads" : "Not on the map"}
        />
      </div>
      {map !== null && map.nodes.length > 0 ? <SuperThreadMapFooter nodes={map.nodes} /> : null}
    </div>
  );
}
