import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SUPER_THREAD_MAP_NODE_HEIGHT,
  SUPER_THREAD_MAP_NODE_WIDTH,
  SUPER_THREAD_MAP_STATE_LABELS,
  layoutSuperThreadMap,
  resolveSuperThreadMapNodeState,
  superThreadMapChangesSince,
  type SuperThreadMapLayoutNode,
  type SuperThreadMapNodeState,
} from "@t3tools/client-runtime/state/super-thread-map";
import type {
  EnvironmentId,
  SuperThreadMap as SuperThreadMapState,
  SuperThreadMember,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
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
  UnplugIcon,
} from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { environmentThreadShells } from "../../state/threads";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { SuperThreadStatus } from "./SuperThreadStatus";

const STATE_PRESENTATION: Record<
  SuperThreadMapNodeState,
  { readonly icon: typeof CircleIcon; readonly className: string }
> = {
  "needs-you": {
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  failed: { icon: CircleAlertIcon, className: "text-error-foreground" },
  dropped: { icon: CircleSlash2Icon, className: "text-muted-foreground" },
  working: { icon: CircleDashedIcon, className: "text-info-foreground" },
  blocked: { icon: OctagonMinusIcon, className: "text-warning-foreground" },
  done: { icon: CircleCheckIcon, className: "text-success-foreground" },
  active: { icon: CircleDotIcon, className: "text-info-foreground" },
  planned: { icon: CircleIcon, className: "text-muted-foreground" },
};

// One atom per node's thread list, so a thread's update repaints only the nodes that link it.
const linkedShellsAtom = Atom.family((key: string) => {
  const refs = (JSON.parse(key) as Array<[EnvironmentId, ThreadId]>).map(([environmentId, id]) =>
    scopeThreadRef(environmentId, id),
  );
  return Atom.make((get) =>
    refs.map((ref) => get(environmentThreadShells.quietThreadShellAtom(ref))),
  );
});

const threadsKey = (threads: ReadonlyArray<SuperThreadMember> | undefined) =>
  JSON.stringify((threads ?? []).map((thread) => [thread.environmentId, thread.threadId]));

const SuperThreadMapNode = memo(function SuperThreadMapNode(props: {
  readonly placed: SuperThreadMapLayoutNode;
  readonly isNew: boolean;
}) {
  const { node, x, y } = props.placed;
  const shells = useAtomValue(linkedShellsAtom(threadsKey(node.threads)));
  const { state, unreachable } = resolveSuperThreadMapNodeState(node.status, shells);
  const [open, setOpen] = useState(false);
  const { icon: Icon, className } = STATE_PRESENTATION[state];
  const only = node.threads?.length === 1 ? node.threads[0]! : null;
  const box = cn(
    "absolute flex flex-col justify-center gap-1 rounded-lg border bg-background px-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    state === "planned" && "border-dashed",
    state === "needs-you" ? cn(className, "border-current") : "border-border",
    state === "dropped" && "opacity-55",
  );
  const style = {
    left: x,
    top: y,
    width: SUPER_THREAD_MAP_NODE_WIDTH,
    height: SUPER_THREAD_MAP_NODE_HEIGHT,
  };
  const content = (
    <>
      <span className={cn("flex items-center gap-1 text-xs font-medium", className)}>
        <Icon aria-hidden className="size-3 shrink-0" />
        {SUPER_THREAD_MAP_STATE_LABELS[state]}
        {node.threads !== undefined && node.threads.length > 1 ? (
          <span className="text-muted-foreground">· {node.threads.length} threads</span>
        ) : null}
        {unreachable ? (
          <UnplugIcon
            aria-label="A thread can't be reached"
            className="size-3 text-muted-foreground"
          />
        ) : null}
        {props.isNew ? (
          <span
            aria-label="New since you looked"
            className="ml-auto size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </span>
      <span
        className={cn(
          "line-clamp-2 text-sm leading-snug font-medium text-foreground",
          state === "dropped" && "line-through",
        )}
      >
        {node.title}
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
            <button type="button" className={box} style={style} onClick={() => setOpen(true)} />
          ) : (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: only.environmentId, threadId: only.threadId }}
              className={box}
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
                        params={{ environmentId: thread.environmentId, threadId: thread.threadId }}
                        className="flex items-center gap-2 rounded-md px-1 py-0.5 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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

/** The plan the super agent draws; people read it and steer through the prompt box. */
export function SuperThreadMap(props: {
  readonly map: SuperThreadMapState;
  /** When the person last looked before opening the page. */
  readonly seenAt: string | null | undefined;
}) {
  const { map } = props;
  const layout = layoutSuperThreadMap(map);
  const since = superThreadMapChangesSince(map, props.seenAt);

  return (
    <section aria-label="Task map" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Map</h2>
      {since.changes.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
          <p className="font-medium text-foreground">
            {since.changes.length === 1
              ? "The plan changed since you looked"
              : `The plan changed ${since.changes.length} times since you looked`}
          </p>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {since.changes.map((change) => (
              <li key={change.revision}>
                {change.reason}
                {change.removed.length > 0
                  ? ` · removed ${change.removed.map((node) => `"${node.title}"`).join(", ")}`
                  : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {map.nodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">The agent has not drawn any work yet.</p>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-xl border border-border/70 bg-muted/20">
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
            {layout.lanes.map((lane) =>
              lane.group === null ? null : (
                <div
                  key={lane.group}
                  aria-hidden
                  className="absolute inset-x-2 rounded-lg border border-border/60"
                  style={{ top: lane.y, height: lane.height }}
                >
                  <span className="absolute top-1 left-3 text-xs font-medium text-muted-foreground">
                    {lane.group}
                  </span>
                </div>
              ),
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
                  markerWidth="7"
                  markerHeight="7"
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
                  strokeOpacity={0.7}
                  strokeWidth={1.25}
                  {...(edge.kind === "depends"
                    ? { markerEnd: "url(#super-thread-map-arrow)" }
                    : { strokeDasharray: "4 4" })}
                />
              ))}
            </svg>
            {layout.edges.map((edge) =>
              edge.label === undefined ? null : (
                <span
                  key={`${edge.from}\u0000${edge.to}`}
                  className="pointer-events-none absolute max-w-40 -translate-x-1/2 -translate-y-1/2 truncate rounded bg-background px-1 text-2xs text-muted-foreground"
                  style={{ left: edge.labelX, top: edge.labelY }}
                >
                  {edge.label}
                </span>
              ),
            )}
            {layout.nodes.map((placed) => (
              <SuperThreadMapNode
                key={placed.node.id}
                placed={placed}
                isNew={since.addedNodeIds.has(placed.node.id)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
