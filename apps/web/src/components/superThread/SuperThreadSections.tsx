import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SuperThreadSection } from "@t3tools/client-runtime/state/super-threads";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { CheckIcon, NetworkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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

const SuperThreadHeaderRow = memo(function SuperThreadHeaderRow(props: {
  readonly header: EnvironmentThreadShell;
  readonly rowKey: string;
  readonly active: boolean;
  readonly onNavigate: () => void;
  readonly onSettle: (threadRef: ScopedThreadRef) => void;
}) {
  const { header, rowKey, active } = props;
  const { status } = useSuperThreadRowState(header, active);
  const settled = header.settledOverride === "settled";
  return (
    <div className={rowSurfaceClassName(active, false)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/super/$superEnvironmentId/$superThreadId"
              params={{ superEnvironmentId: header.environmentId, superThreadId: header.id }}
              data-sidebar-row={rowKey}
              aria-current={active ? "page" : undefined}
              onClick={props.onNavigate}
              className={cn(
                rowFocusClassName,
                "flex h-9 w-full min-w-0 items-center gap-2.5 px-2.5",
              )}
            />
          }
        >
          <NetworkIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {header.title}
          </span>
          <span
            className={cn(
              "flex min-w-8 shrink-0 justify-end",
              !settled &&
                "group-any-hover/sidebar-row:opacity-0 group-focus-within/sidebar-row:opacity-0",
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
                className="pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center rounded-md bg-transparent px-2.5 text-muted-foreground opacity-0 transition-opacity outline-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100 group-focus-within/sidebar-row:pointer-events-auto group-focus-within/sidebar-row:opacity-100"
              />
            }
          >
            <CheckIcon aria-hidden className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Settle with its threads</TooltipPopup>
        </Tooltip>
      )}
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
}) {
  const { thread, active } = props;
  const { status, recede, readFailure } = useSuperThreadRowState(thread, active);
  return (
    <li className="list-none">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: thread.environmentId, threadId: thread.id }}
              data-sidebar-row={props.rowKey}
              data-sidebar-parent={props.parentKey}
              aria-current={active ? "page" : undefined}
              onClick={props.onNavigate}
              className={cn(
                rowSurfaceClassName(active, recede),
                rowFocusClassName,
                "flex flex-col justify-center py-1.5 ps-9 pe-2.5",
              )}
            />
          }
        >
          <span className="flex h-5 min-w-0 items-center gap-1.5">
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs text-secondary-label">
              {props.hint}
            </span>
            <SuperThreadStatusLabel status={status} />
          </span>
          <span
            className={cn(
              "mt-0.5 min-w-0 truncate text-sm",
              recede
                ? "font-normal text-foreground/75 group-hover/sidebar-row:text-foreground group-focus-visible/sidebar-row:text-foreground"
                : readFailure
                  ? "font-medium text-foreground/95"
                  : "font-medium text-foreground",
            )}
          >
            {thread.title}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right">{thread.title}</TooltipPopup>
      </Tooltip>
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
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const params = useParams({ strict: false });
  if (props.sections.length === 0) return null;
  const openSuperKey =
    params.superEnvironmentId && params.superThreadId
      ? scopedThreadKey(
          scopeThreadRef(
            EnvironmentId.make(params.superEnvironmentId),
            ThreadId.make(params.superThreadId),
          ),
        )
      : null;
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <>
      {props.sections.map(({ header, rows }) => {
        const headerKey = scopedThreadKey(scopeThreadRef(header.environmentId, header.id));
        const showEnvironment = rows.some((row) => row.environmentId !== header.environmentId);
        return (
          <li key={headerKey} className="list-none py-0.5" data-testid="super-thread-section">
            <SuperThreadHeaderRow
              header={header}
              rowKey={headerKey}
              active={openSuperKey === headerKey || props.routeThreadKey === headerKey}
              onNavigate={closeMobileSidebar}
              onSettle={props.onSettle}
            />
            {rows.length > 0 ? (
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
