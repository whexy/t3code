import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  ScopedThreadRef,
  SuperThreadMap as SuperThreadMapState,
  SuperThreadMember,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { ThreadVisitWatermark } from "../chat/ThreadVisitWatermark";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SuperThreadMap } from "./SuperThreadMap";
import { SuperThreadMembers } from "./SuperThreadMembers";
import { SuperThreadPendingRequests } from "./SuperThreadPendingRequests";
import { SuperThreadPromptBox } from "./SuperThreadPromptBox";

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

function SuperThreadSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-4 w-2/3 max-w-md" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton shape="card" className="h-24 w-full" />
      </div>
    </div>
  );
}

/** The super thread's own page: its goal, task map, open requests, threads and a prompt box. */
export function SuperThreadPage(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const shell = useQuietThreadShell(threadRef);
  const detail = useQuietThreadProjection(threadRef);
  const status = useThreadStatus(threadRef);
  const superThread = detail?.projection.thread.superThread;
  const members = superThread?.members ?? shell?.source.superThread?.members ?? [];
  const map = superThread?.map ?? null;
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  // Read in the render that first has the shell, before this page's own visit moves it.
  const [seen, setSeen] = useState<{ readonly at: string | undefined } | null>(null);
  if (seen === null && shell !== null) {
    setSeen({ at: resolveThreadLastVisitedAt(shell.lastVisitedAt, localLastVisitedAt) });
  }
  const transcriptLink = (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: threadRef.environmentId, threadId: threadRef.threadId }}
    />
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {shell === null ? null : <ThreadVisitWatermark threadRef={threadRef} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <NetworkIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
          <WorkspaceBreadcrumb ariaLabel="Super thread breadcrumb" className="flex-1">
            <WorkspaceBreadcrumbItem>Super thread</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">{shell?.title ?? "Loading"}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <Button variant="outline" size="sm" render={transcriptLink}>
            Open transcript
          </Button>
        </WorkspacePageHeader>
        {shell === null && status !== "deleted" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" aria-busy>
              <SuperThreadSkeleton />
            </WorkspacePageContainer>
          </div>
        ) : shell === null ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>This thread was deleted</EmptyTitle>
              <EmptyDescription>The threads it launched stay where they are.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : shell.source.superThread === undefined ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>Not a super thread</EmptyTitle>
              <EmptyDescription>Open its transcript to continue the conversation.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
              <WorkspacePageContainer width="expanded">
                {detail === null ? (
                  <SuperThreadSkeleton />
                ) : (
                  <>
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
                    <SuperThreadPendingRequests threadRef={threadRef} title={shell.title} />
                    {map !== null ? <SuperThreadMap map={map} seenAt={seen?.at} /> : null}
                    <SuperThreadMembers
                      members={map === null ? members : membersNotOnMap(members, map)}
                      title={map === null ? "Threads" : "Not on the map"}
                    />
                  </>
                )}
              </WorkspacePageContainer>
            </div>
            <div className="border-t border-border bg-background">
              <WorkspacePageContainer width="expanded" className="py-3">
                <SuperThreadPromptBox thread={shell} />
              </WorkspacePageContainer>
            </div>
          </>
        )}
      </div>
    </SidebarInset>
  );
}
