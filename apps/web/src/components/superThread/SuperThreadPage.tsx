import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";

import { isElectron } from "../../env";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import {
  useQuietThreadProjection,
  useQuietThreadShells,
  useThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SuperThreadBoard } from "./SuperThreadBoard";
import { SuperThreadMembers } from "./SuperThreadMembers";
import { SuperThreadPendingRequests } from "./SuperThreadPendingRequests";
import { SuperThreadPromptBox } from "./SuperThreadPromptBox";

function useLookups() {
  const shells = useQuietThreadShells();
  const projectGroups = useSidebarProjectGroups();
  const environments = useEnvironmentIdentities();
  return {
    shellByKey: new Map(
      shells.map(
        (shell) => [scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)), shell] as const,
      ),
    ),
    projectDisplayNameByKey: new Map(
      projectGroups.flatMap((group) =>
        group.memberProjects.map(
          (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
        ),
      ),
    ),
    environmentLabelById: new Map(
      environments.map((environment) => [environment.environmentId, environment.label] as const),
    ),
  };
}

/** The super thread's own page: its goal board, members, open requests and a prompt box. */
export function SuperThreadPage(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const shell = useThreadShell(threadRef);
  const detail = useQuietThreadProjection(threadRef);
  const status = useThreadStatus(threadRef);
  const lookups = useLookups();
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <NetworkIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {shell?.title ?? "Super thread"}
          </h1>
          <Button variant="outline" size="sm" render={transcriptLink}>
            Open transcript
          </Button>
        </WorkspacePageHeader>
        {shell === null ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>
                {status === "deleted" ? "This thread was deleted" : "Loading super thread"}
              </EmptyTitle>
              <EmptyDescription>
                {status === "deleted"
                  ? "Its threads stay where they are."
                  : "If this takes long, its environment may be offline."}
              </EmptyDescription>
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
            <div className="min-h-0 flex-1 overflow-y-auto">
              <WorkspacePageContainer width="expanded">
                <section aria-label="Goal" className="flex flex-col gap-1">
                  <h2 className="text-sm font-medium text-foreground">Goal</h2>
                  {board !== null && board.goal.trim().length > 0 ? (
                    <p className="whitespace-pre-wrap text-sm text-foreground">{board.goal}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {detail === null
                        ? "Loading the board…"
                        : "No goal yet. The agent writes it once it has a plan."}
                    </p>
                  )}
                </section>
                <SuperThreadPendingRequests threadRef={threadRef} title={shell.title} />
                {board !== null ? (
                  <SuperThreadBoard board={board} shellByKey={lookups.shellByKey} />
                ) : null}
                <SuperThreadMembers
                  members={members}
                  shellByKey={lookups.shellByKey}
                  projectDisplayNameByKey={lookups.projectDisplayNameByKey}
                  environmentLabelById={lookups.environmentLabelById}
                />
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
