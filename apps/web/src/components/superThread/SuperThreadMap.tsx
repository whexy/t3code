import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SUPER_THREAD_MAP_NODE_HEIGHT,
  SUPER_THREAD_MAP_SIDE_LABEL_WIDTH,
  SUPER_THREAD_MAP_STATE_LABELS,
  layoutSuperThreadMap,
  resolveSuperThreadMapNodeState,
  superThreadMapChangesSince,
  type SuperThreadMapLayoutNode,
} from "@t3tools/client-runtime/state/super-thread-map";
import type { SuperThreadMap as SuperThreadMapState } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { HistoryIcon, LayersIcon, UnplugIcon, WorkflowIcon } from "lucide-react";
import { memo, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { linkedShellsAtom, STATE_PRESENTATION, threadsKey } from "./superThreadMapState";
import { SuperThreadPanelHeading } from "./SuperThreadPanelHeading";
import { SuperThreadStatus } from "./SuperThreadStatus";

interface Relation {
  readonly title: string;
  readonly label: string | undefined;
}

// The app's inline boxes (composer context, tool tiles), with the panel rows' hover.
const NODE_CLASS =
  "absolute flex flex-col justify-center gap-0.5 rounded-lg border border-border/70 bg-card px-2.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const SuperThreadMapNode = memo(function SuperThreadMapNode(props: {
  readonly placed: SuperThreadMapLayoutNode;
  readonly width: number;
  readonly relates: ReadonlyArray<Relation>;
  readonly isNew: boolean;
}) {
  const { node, x, y } = props.placed;
  const shells = useAtomValue(linkedShellsAtom(threadsKey(node.threads)));
  const { state, unreachable } = resolveSuperThreadMapNodeState(node.status, shells);
  const [open, setOpen] = useState(false);
  const { icon: Icon, className } = STATE_PRESENTATION[state];
  const only = node.threads?.length === 1 ? node.threads[0]! : null;
  const style = { left: x, top: y, width: props.width, height: SUPER_THREAD_MAP_NODE_HEIGHT };
  const content = (
    <>
      <span
        className={cn(
          "line-clamp-2 text-sm leading-snug",
          state === "dropped"
            ? "font-normal text-foreground/75 line-through"
            : "font-medium text-foreground",
        )}
      >
        {node.title}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className={cn("inline-flex shrink-0 items-center gap-1 font-medium", className)}>
          <Icon aria-hidden className="size-3" />
          {SUPER_THREAD_MAP_STATE_LABELS[state]}
        </span>
        {node.threads !== undefined && node.threads.length > 1 ? (
          <span className="truncate text-secondary-label">· {node.threads.length} threads</span>
        ) : null}
        {unreachable ? (
          <UnplugIcon
            aria-label="A thread can't be reached"
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : null}
        {props.isNew ? (
          <span
            role="img"
            aria-label="New since you looked"
            className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
          />
        ) : null}
      </span>
    </>
  );
  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger
        delay={300}
        closeDelay={150}
        render={
          only === null ? (
            <button
              type="button"
              className={NODE_CLASS}
              style={style}
              onClick={() => setOpen(true)}
            />
          ) : (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: only.environmentId, threadId: only.threadId }}
              className={NODE_CLASS}
              style={style}
            />
          )
        }
      >
        {content}
      </PreviewCardTrigger>
      <PreviewCardPopup className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-2 p-3 text-sm">
          <p className="font-medium text-foreground">{node.title}</p>
          {node.detail ? (
            <p className="whitespace-pre-wrap text-muted-foreground">{node.detail}</p>
          ) : null}
          {node.note ? <p className="whitespace-pre-wrap text-foreground">{node.note}</p> : null}
          {props.relates.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {props.relates.map((relation) => (
                <li key={relation.title}>
                  Related to {relation.title}
                  {relation.label ? `: ${relation.label}` : null}
                </li>
              ))}
            </ul>
          ) : null}
          {node.threads !== undefined && node.threads.length > 0 ? (
            <ul className="flex flex-col gap-1 border-t border-border pt-2">
              {node.threads.map((thread, index) => {
                const shell = shells[index] ?? null;
                return (
                  <li key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.threadId))}>
                    {shell === null ? (
                      <span className="text-xs text-muted-foreground">
                        A thread this client can't reach right now
                      </span>
                    ) : (
                      <Link
                        to="/$environmentId/$threadId"
                        params={{
                          environmentId: thread.environmentId,
                          threadId: thread.threadId,
                        }}
                        className="flex items-center gap-2 rounded-md px-1 py-0.5 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      >
                        <span className="min-w-0 flex-1 truncate">{shell.title}</span>
                        <SuperThreadStatus thread={shell} />
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
});

/** The plan the super agent draws; people read it and steer through the conversation. */
export function SuperThreadMap(props: {
  readonly map: SuperThreadMapState;
  /** When the person last looked before this look at the panel. */
  readonly seenAt: string | null | undefined;
}) {
  const { map } = props;
  const [availableWidth, setAvailableWidth] = useState<number>();
  const since = superThreadMapChangesSince(map, props.seenAt);
  const layout = layoutSuperThreadMap(map, availableWidth === undefined ? {} : { availableWidth });
  const titleById = new Map(map.nodes.map((node) => [node.id, node.title]));
  const relates = new Map<string, Array<Relation>>();
  for (const edge of map.edges) {
    if (edge.kind !== "relates") continue;
    const from = titleById.get(edge.from) ?? edge.from;
    const to = titleById.get(edge.to) ?? edge.to;
    relates.set(edge.from, [...(relates.get(edge.from) ?? []), { title: to, label: edge.label }]);
    relates.set(edge.to, [...(relates.get(edge.to) ?? []), { title: from, label: edge.label }]);
  }
  const labelled = layout.lanes.some((lane) => lane.group !== null);
  return (
    <>
      {since.changes.length > 0 ? (
        <section aria-label="Changed since you looked" className="space-y-0.5">
          <SuperThreadPanelHeading
            icon={HistoryIcon}
            title="Changed since you looked"
            count={since.changes.length}
          />
          <ul className="flex flex-col gap-0.5 px-2.5 text-xs text-muted-foreground">
            {since.changes.map((change) => (
              <li key={change.revision}>
                {change.reason}
                {change.removed.length > 0
                  ? ` · removed ${change.removed.map((node) => `"${node.title}"`).join(", ")}`
                  : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="Task map" className="space-y-0.5">
        {labelled ? null : (
          <SuperThreadPanelHeading icon={WorkflowIcon} title="Task map" count={map.nodes.length} />
        )}
        {map.nodes.length === 0 ? (
          <p className="px-2.5 py-1 text-sm text-muted-foreground">
            The agent has not drawn any work yet.
          </p>
        ) : (
          // -ml-2.5 lines the nodes up with the panel's headings; min-w-0 keeps a wide map
          // scrolling inside the panel instead of widening it.
          <div
            ref={(element) => {
              if (element === null) return;
              const update = () => setAvailableWidth(element.clientWidth);
              update();
              return observeResize(element, update);
            }}
            className="-ml-2.5 max-h-[70vh] min-w-0 overflow-auto"
          >
            <div
              className="relative min-w-full"
              style={{ width: layout.width, height: layout.height }}
            >
              {layout.lanes.map((lane) =>
                labelled ? (
                  // The lane's name in the panel's heading style, across the map's width.
                  <div
                    key={lane.group ?? ""}
                    className="absolute inset-x-0"
                    style={{ top: lane.y + 2, left: 10 }}
                  >
                    <SuperThreadPanelHeading
                      icon={LayersIcon}
                      title={lane.group ?? "Other"}
                      count={
                        layout.nodes.filter(({ node }) => (node.group ?? null) === lane.group)
                          .length
                      }
                    />
                  </div>
                ) : null,
              )}
              <svg
                aria-hidden
                className="pointer-events-none absolute inset-0 text-muted-foreground"
                width={layout.width}
                height={layout.height}
              >
                <defs>
                  <marker
                    id="super-thread-map-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
                  </marker>
                </defs>
                {layout.edges.map((edge) => (
                  <path
                    key={`${edge.from}\u0000${edge.to}`}
                    d={edge.path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1}
                    {...(edge.kind === "depends"
                      ? { markerEnd: "url(#super-thread-map-arrow)" }
                      : { strokeDasharray: "3 3" })}
                  />
                ))}
              </svg>
              {layout.edges.map((edge) =>
                edge.label === undefined ? null : (
                  <span
                    key={`${edge.from}\u0000${edge.to}`}
                    className={cn(
                      "pointer-events-none absolute -translate-y-1/2 truncate bg-background px-1 text-xs text-muted-foreground",
                      edge.labelAnchor === "center" && "-translate-x-1/2",
                    )}
                    style={{
                      left: edge.labelAnchor === "side" ? edge.labelX + 8 : edge.labelX,
                      top: edge.labelY,
                      maxWidth: SUPER_THREAD_MAP_SIDE_LABEL_WIDTH,
                    }}
                  >
                    {edge.label}
                  </span>
                ),
              )}
              {layout.nodes.map((placed) => (
                <SuperThreadMapNode
                  key={placed.node.id}
                  placed={placed}
                  width={layout.nodeWidth}
                  relates={relates.get(placed.node.id) ?? []}
                  isNew={since.addedNodeIds.has(placed.node.id)}
                />
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
