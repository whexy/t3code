import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";

import { isElectron } from "../../env";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { ThreadVisitWatermark } from "../chat/ThreadVisitWatermark";
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
import { SuperThreadBoard } from "./SuperThreadBoard";
import { SuperThreadMembers } from "./SuperThreadMembers";
import { SuperThreadPendingRequests } from "./SuperThreadPendingRequests";
import { SuperThreadPromptBox } from "./SuperThreadPromptBox";

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

/** The super thread's own page: its goal board, members, open requests and a prompt box. */
export function SuperThreadPage(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const shell = useQuietThreadShell(threadRef);
  const detail = useQuietThreadProjection(threadRef);
  const status = useThreadStatus(threadRef);
  const superThread = detail?.projection.thread.superThread;
  const members = superThread?.members ?? shell?.source.superThread?.members ?? [];
  const board = superThread?.board ?? null;
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
                      {board !== null && board.goal.trim().length > 0 ? (
                        <p className="whitespace-pre-wrap text-sm text-foreground">{board.goal}</p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No goal yet. The agent writes it once it has a plan.
                        </p>
                      )}
                    </section>
                    <SuperThreadPendingRequests threadRef={threadRef} title={shell.title} />
                    {board !== null ? <SuperThreadBoard board={board} /> : null}
                    <SuperThreadMembers members={members} />
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
