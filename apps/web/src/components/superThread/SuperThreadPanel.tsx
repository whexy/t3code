import type {
  ScopedThreadRef,
  SuperThreadMap as SuperThreadMapState,
  SuperThreadMember,
} from "@t3tools/contracts";

import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { SuperThreadMap } from "./SuperThreadMap";
import { SuperThreadMembers } from "./SuperThreadMembers";
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
    <div aria-busy className="flex flex-col gap-6 p-4">
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
    // Takes focus when the panel opens, so a map node's hover card doesn't open by itself.
    <div
      data-workspace-focus-default
      tabIndex={-1}
      className="h-full min-h-0 overflow-y-auto outline-none"
    >
      <div className="flex flex-col gap-6 p-4">
        <section aria-label="Goal" className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-foreground">Goal</h2>
          {map !== null && map.goal.trim().length > 0 ? (
            <p className="whitespace-pre-wrap text-sm text-foreground">{map.goal}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
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
    </div>
  );
}
