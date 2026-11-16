import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { SuperThreadSection } from "@t3tools/client-runtime/state/super-threads";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { CircleCheckIcon, NetworkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SuperThreadStatus } from "./SuperThreadStatus";

const rowClassName = (active: boolean) =>
  cn(
    "group/sidebar-row flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    active
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
  );

function memberHint(
  thread: EnvironmentThreadShell,
  projectDisplayNameByKey: ReadonlyMap<string, string>,
  environmentLabelById: ReadonlyMap<EnvironmentId, string>,
  showEnvironment: boolean,
): string | null {
  const project = projectDisplayNameByKey.get(`${thread.environmentId}:${thread.projectId}`);
  const environment = showEnvironment ? environmentLabelById.get(thread.environmentId) : undefined;
  const parts = [project, environment].filter((part): part is string => !!part);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** One group per super thread, above the sidebar's own sections; see docs/internals/super-threads.md. */
export const SuperThreadSections = memo(function SuperThreadSections(props: {
  readonly sections: ReadonlyArray<SuperThreadSection<EnvironmentThreadShell>>;
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
        const headerActive = openSuperKey === headerKey || props.routeThreadKey === headerKey;
        const showEnvironment = rows.some((row) => row.environmentId !== header.environmentId);
        const headerSettled = header.settledOverride === "settled";
        return (
          <li key={headerKey} className="list-none py-0.5" data-testid="super-thread-section">
            <div className="flex items-center gap-0.5">
              <Link
                to="/super/$superEnvironmentId/$superThreadId"
                params={{ superEnvironmentId: header.environmentId, superThreadId: header.id }}
                aria-current={headerActive ? "page" : undefined}
                onClick={closeMobileSidebar}
                className={rowClassName(headerActive)}
              >
                <NetworkIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {header.title}
                </span>
                {headerSettled ? (
                  <span className="shrink-0 text-xs text-muted-foreground">Settled</span>
                ) : (
                  <SuperThreadStatus thread={header} />
                )}
              </Link>
              {headerSettled ? null : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost-muted"
                        size="icon-xs"
                        aria-label={`Settle ${header.title} and its threads`}
                        onClick={() =>
                          props.onSettle(scopeThreadRef(header.environmentId, header.id))
                        }
                      />
                    }
                  >
                    <CircleCheckIcon aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Settle with its threads</TooltipPopup>
                </Tooltip>
              )}
            </div>
            {rows.length > 0 ? (
              <ul aria-label={`Threads launched by ${header.title}`} className="flex flex-col">
                {rows.map((row) => {
                  const rowKey = scopedThreadKey(scopeThreadRef(row.environmentId, row.id));
                  const active = props.routeThreadKey === rowKey;
                  const hint = memberHint(
                    row,
                    props.projectDisplayNameByKey,
                    props.environmentLabelById,
                    showEnvironment,
                  );
                  return (
                    <li key={rowKey} className="list-none">
                      <Link
                        to="/$environmentId/$threadId"
                        params={{ environmentId: row.environmentId, threadId: row.id }}
                        aria-current={active ? "page" : undefined}
                        onClick={closeMobileSidebar}
                        className={cn(rowClassName(active), "pl-8")}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-foreground/90">{row.title}</span>
                          {hint === null ? null : (
                            <span className="truncate text-xs text-muted-foreground">{hint}</span>
                          )}
                        </span>
                        <SuperThreadStatus thread={row} />
                      </Link>
                    </li>
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
