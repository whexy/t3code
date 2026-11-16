import type { ScopedThreadRef } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";

import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShell } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { toggleSuperThreadPanel } from "./superThreadPanelActions";

/** A super thread's header label, which shows and hides its goal and task map. */
export function SuperThreadBreadcrumb(props: { readonly threadRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(props.threadRef);
  const showing = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, props.threadRef) === "super-thread",
  );
  if (shell?.source.superThread === undefined) return null;
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-pressed={showing}
                onClick={() => toggleSuperThreadPanel(props.threadRef)}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:text-foreground"
              />
            }
          >
            <NetworkIcon aria-hidden className="size-3.5" />
            <WorkspaceBreadcrumbText>Super thread</WorkspaceBreadcrumbText>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {showing ? "Hide goal and task map" : "Show goal and task map"}
          </TooltipPopup>
        </Tooltip>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
