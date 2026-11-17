import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, SuperThreadMapNode } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { nodeStateCountsAtom, nodeStatesKey, STATE_PRESENTATION } from "./superThreadMapState";
import { toggleSuperThreadPanel } from "./superThreadPanelActions";

function SuperThreadMapRows(props: {
  readonly threadRef: ScopedThreadRef;
  readonly nodes: ReadonlyArray<SuperThreadMapNode>;
}) {
  const counts = useAtomValue(nodeStateCountsAtom(nodeStatesKey(props.nodes)));
  const needsYou = counts.get("needs-you") ?? 0;
  const { icon: NeedsYouIcon, className } = STATE_PRESENTATION["needs-you"];
  const open = () => toggleSuperThreadPanel(props.threadRef);
  return (
    <>
      <ThreadDetailsControl onClick={open}>
        <NetworkIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0">Task map</span>
          {props.nodes.length > 0 ? (
            <span className="ml-auto shrink-0 ps-2 text-xs font-normal tabular-nums text-muted-foreground">
              {counts.get("done") ?? 0}/{props.nodes.length} done
            </span>
          ) : null}
        </span>
      </ThreadDetailsControl>
      {needsYou > 0 ? (
        <ThreadDetailsControl onClick={open}>
          <NeedsYouIcon aria-hidden className={cn("size-4 shrink-0", className)} />
          <span className={cn("min-w-0 flex-1 truncate", className)}>
            {needsYou === 1 ? "1 piece needs you" : `${needsYou} pieces need you`}
          </span>
        </ThreadDetailsControl>
      ) : null}
    </>
  );
}

/** A super thread's map at a glance in the thread details card; renders nothing elsewhere. */
export function SuperThreadDetailsSection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly density: "full" | "compact" | "essential";
}) {
  const { threadRef } = props;
  const shell = useQuietThreadShell(threadRef);
  const detail = useQuietThreadProjection(threadRef);
  if (shell?.source?.superThread === undefined) return null;
  const nodes = detail?.projection.thread.superThread?.map?.nodes ?? [];
  return (
    <ThreadDetailsSection
      headingId="thread-details-super-thread-heading"
      title="Super thread"
      showHeading={false}
      separated={props.density === "full"}
    >
      <div className="flex flex-col">
        <SuperThreadMapRows threadRef={threadRef} nodes={nodes} />
      </div>
    </ThreadDetailsSection>
  );
}
