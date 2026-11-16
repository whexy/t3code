import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  superThreadMemberNeedsYou,
  type SuperThreadSection,
} from "@t3tools/client-runtime/state/super-threads";
import {
  AuthOrchestrationOperateScope,
  type ContextMenuSource,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, NetworkIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import { ThreadRenameInput } from "../sidebar/SidebarThreadRow";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toggleSuperThreadFold, useFoldedSuperThreadKeys } from "./superThreadFolds";
import { SuperThreadStatusLabel, useSuperThreadRowState } from "./SuperThreadStatus";

// The surface of the sidebar's own thread rows, so the section reads as part of the same list.
const rowSurfaceClassName = (active: boolean, recede: boolean) =>
  cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
    active
      ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
      : recede
        ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
  );

const rowFocusClassName =
  "rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

const memberSettleButtonClassName =
  "pointer-events-none absolute top-1.5 right-0 inline-flex h-5 cursor-pointer items-center rounded-md bg-transparent px-2.5 text-muted-foreground opacity-0 transition-opacity outline-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100 group-has-[:focus-visible]/sidebar-row:pointer-events-auto group-has-[:focus-visible]/sidebar-row:opacity-100";

/** The sidebar's thread actions a member row reuses, so it acts like the sidebar's own rows. */
export interface SuperThreadMemberRowActions {
  readonly onSettle: (threadRef: ScopedThreadRef) => void;
  readonly onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  readonly onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  readonly onRenameTitleChange: (title: string) => void;
  readonly onCommitRename: (threadRef: ScopedThreadRef, title: string) => void;
  readonly onCancelRename: () => void;
}

const SuperThreadHeaderRow = memo(function SuperThreadHeaderRow(props: {
  readonly header: EnvironmentThreadShell;
  readonly rowKey: string;
  readonly active: boolean;
  /** Set while folded: how many members the fold hides, and how many of those need the person. */
  readonly folded: { readonly hidden: number; readonly needsYou: number } | null;
  readonly onNavigate: () => void;
  readonly onSettle: (threadRef: ScopedThreadRef) => void;
}) {
  const { header, rowKey, active, folded } = props;
  const { status } = useSuperThreadRowState(header, active);
  const settled = header.settledOverride === "settled";
  return (
    <div className={rowSurfaceClassName(active, false)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: header.environmentId, threadId: header.id }}
              data-sidebar-row={rowKey}
              aria-current={active ? "page" : undefined}
              onClick={props.onNavigate}
              className={cn(
                rowFocusClassName,
                "flex h-9 w-full min-w-0 items-center gap-2.5 ps-2.5 pe-8",
              )}
            />
          }
        >
          <NetworkIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {header.title}
          </span>
          {folded === null ? null : folded.needsYou > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums text-warning-foreground">
              <CircleAlertIcon aria-hidden className="size-3 shrink-0" />
              {folded.needsYou}
              <span className="sr-only">{folded.needsYou === 1 ? " needs you" : " need you"}</span>
            </span>
          ) : folded.hidden > 0 ? (
            <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
              {folded.hidden}
              <span className="sr-only"> hidden</span>
            </span>
          ) : null}
          <span
            className={cn(
              "flex min-w-8 shrink-0 justify-end",
              !settled &&
                "group-any-hover/sidebar-row:opacity-0 group-has-[:focus-visible]/sidebar-row:opacity-0",
            )}
          >
            {settled ? (
              <span className="text-xs text-secondary-label">Settled</span>
            ) : (
              <SuperThreadStatusLabel status={status} />
            )}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right">{header.title}</TooltipPopup>
      </Tooltip>
      {settled ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-sidebar-action-for={rowKey}
                aria-label={`Settle ${header.title} and its threads`}
                onClick={() => props.onSettle(scopeThreadRef(header.environmentId, header.id))}
                className="pointer-events-none absolute inset-y-0 right-7 inline-flex cursor-pointer items-center rounded-md bg-transparent px-2.5 text-muted-foreground opacity-0 transition-opacity outline-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100 group-has-[:focus-visible]/sidebar-row:pointer-events-auto group-has-[:focus-visible]/sidebar-row:opacity-100"
              />
            }
          >
            <CheckIcon aria-hidden className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Settle with its threads</TooltipPopup>
        </Tooltip>
      )}
      <button
        type="button"
        aria-expanded={folded === null}
        aria-label={folded === null ? `Fold ${header.title}` : `Unfold ${header.title}`}
        onClick={() => toggleSuperThreadFold(rowKey)}
        className="absolute inset-y-0 right-0 inline-flex w-8 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 transition-transform", folded !== null && "-rotate-90")}
        />
      </button>
    </div>
  );
});

const SuperThreadMemberRow = memo(function SuperThreadMemberRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly rowKey: string;
  readonly parentKey: string;
  readonly active: boolean;
  readonly project: EnvironmentProject | null;
  readonly hint: string | null;
  readonly onNavigate: () => void;
  readonly actions: SuperThreadMemberRowActions;
  readonly isRenaming: boolean;
  readonly renamingTitle: string;
}) {
  const { thread, active, actions, isRenaming } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const { status, recede, readFailure } = useSuperThreadRowState(thread, active);
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const startRename = () => {
    if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return;
    actions.onStartRename(threadRef, thread.title);
  };
  const rowProps = {
    "data-sidebar-row": props.rowKey,
    "data-sidebar-parent": props.parentKey,
    "aria-current": active ? ("page" as const) : undefined,
    onContextMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      actions.onContextMenu(
        threadRef,
        { x: event.clientX, y: event.clientY },
        contextMenuSourceOf(event),
      );
    },
    className: cn(rowFocusClassName, "flex w-full flex-col justify-center py-1.5 ps-9 pe-2.5"),
  };
  const content = (
    <>
      <span className="flex h-5 min-w-0 items-center gap-1.5">
        {props.project ? (
          <ProjectFavicon project={props.project} className="size-4 shrink-0" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs text-secondary-label">{props.hint}</span>
        <span
          className={cn(
            "flex shrink-0 items-center",
            canOperate &&
              "group-any-hover/sidebar-row:opacity-0 group-has-[:focus-visible]/sidebar-row:opacity-0",
          )}
        >
          <SuperThreadStatusLabel status={status} iconSize="md" />
        </span>
      </span>
      {isRenaming ? (
        <span className="mt-1 flex min-w-0">
          <ThreadRenameInput
            title={props.renamingTitle}
            onTitleChange={actions.onRenameTitleChange}
            onCommit={() => actions.onCommitRename(threadRef, props.renamingTitle)}
            onCancel={actions.onCancelRename}
          />
        </span>
      ) : (
        <span
          className={cn(
            "mt-1 min-w-0 truncate text-sm",
            recede
              ? "font-normal text-foreground/75 group-hover/sidebar-row:text-foreground group-has-[:focus-visible]/sidebar-row:text-foreground"
              : readFailure
                ? "font-medium text-foreground/95"
                : "font-medium text-foreground",
          )}
        >
          {thread.title}
        </span>
      )}
    </>
  );
  return (
    <li className={cn("list-none", rowSurfaceClassName(active, recede))}>
      {isRenaming ? (
        // A link would navigate on every click into the title field.
        <div {...rowProps}>{content}</div>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: thread.environmentId, threadId: thread.id }}
                {...rowProps}
                onClick={props.onNavigate}
                onDoubleClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  startRename();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "F2") return;
                  event.preventDefault();
                  startRename();
                }}
              />
            }
          >
            {content}
          </TooltipTrigger>
          <TooltipPopup side="right">{thread.title}</TooltipPopup>
        </Tooltip>
      )}
      {canOperate && !isRenaming ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-sidebar-action-for={props.rowKey}
                aria-label={`Settle ${thread.title}`}
                onClick={() => actions.onSettle(threadRef)}
                className={memberSettleButtonClassName}
              />
            }
          >
            <CheckIcon aria-hidden className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Settle thread</TooltipPopup>
        </Tooltip>
      ) : null}
    </li>
  );
});

/** One group per super thread, above the sidebar's own sections; see docs/internals/super-threads.md. */
export const SuperThreadSections = memo(function SuperThreadSections(props: {
  readonly sections: ReadonlyArray<SuperThreadSection<EnvironmentThreadShell>>;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly projectDisplayNameByKey: ReadonlyMap<string, string>;
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  /** The open chat route's thread, highlighted when it is a member. */
  readonly routeThreadKey: string | null;
  /** Settles the group; the thread actions ask first and settle the members too. */
  readonly onSettle: (threadRef: ScopedThreadRef) => void;
  readonly onContextMenu: SuperThreadMemberRowActions["onContextMenu"];
  readonly renamingThreadKey: string | null;
  readonly renamingTitle: string;
  readonly onStartRename: SuperThreadMemberRowActions["onStartRename"];
  readonly onRenameTitleChange: SuperThreadMemberRowActions["onRenameTitleChange"];
  readonly onCommitRename: SuperThreadMemberRowActions["onCommitRename"];
  readonly onCancelRename: SuperThreadMemberRowActions["onCancelRename"];
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const foldedKeys = useFoldedSuperThreadKeys();
  if (props.sections.length === 0) return null;
  const memberActions: SuperThreadMemberRowActions = {
    onSettle: props.onSettle,
    onContextMenu: props.onContextMenu,
    onStartRename: props.onStartRename,
    onRenameTitleChange: props.onRenameTitleChange,
    onCommitRename: props.onCommitRename,
    onCancelRename: props.onCancelRename,
  };
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <>
      {props.sections.map(({ header, rows }) => {
        const headerKey = scopedThreadKey(scopeThreadRef(header.environmentId, header.id));
        const showEnvironment = rows.some((row) => row.environmentId !== header.environmentId);
        const isFolded = foldedKeys.includes(headerKey);
        return (
          <li key={headerKey} className="list-none py-0.5" data-testid="super-thread-section">
            <SuperThreadHeaderRow
              header={header}
              rowKey={headerKey}
              active={props.routeThreadKey === headerKey}
              folded={
                isFolded
                  ? { hidden: rows.length, needsYou: rows.filter(superThreadMemberNeedsYou).length }
                  : null
              }
              onNavigate={closeMobileSidebar}
              onSettle={props.onSettle}
            />
            {rows.length > 0 && !isFolded ? (
              <ul
                aria-label={`Threads launched by ${header.title}`}
                className="flex flex-col gap-px"
              >
                {rows.map((row) => {
                  const rowKey = scopedThreadKey(scopeThreadRef(row.environmentId, row.id));
                  const projectKey = `${row.environmentId}:${row.projectId}`;
                  const environment = showEnvironment
                    ? props.environmentLabelById.get(row.environmentId)
                    : undefined;
                  const parts = [props.projectDisplayNameByKey.get(projectKey), environment];
                  const hint = parts.filter((part): part is string => !!part).join(" · ");
                  return (
                    <SuperThreadMemberRow
                      key={rowKey}
                      thread={row}
                      rowKey={rowKey}
                      parentKey={headerKey}
                      active={props.routeThreadKey === rowKey}
                      project={props.projectByKey.get(projectKey) ?? null}
                      hint={hint.length > 0 ? hint : null}
                      onNavigate={closeMobileSidebar}
                      actions={memberActions}
                      isRenaming={props.renamingThreadKey === rowKey}
                      renamingTitle={props.renamingThreadKey === rowKey ? props.renamingTitle : ""}
                    />
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
      <li
        aria-hidden
        data-testid="super-thread-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});
