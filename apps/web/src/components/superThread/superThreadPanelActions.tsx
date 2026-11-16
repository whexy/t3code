import type { ScopedThreadRef } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";

import { useRightPanelStore } from "../../rightPanelStore";

export const SUPER_THREAD_SURFACE_TITLE = "Super thread";

export function SuperThreadSurfaceIcon() {
  return <NetworkIcon className="size-3 shrink-0" />;
}

export function openSuperThreadPanel(threadRef: ScopedThreadRef) {
  useRightPanelStore.getState().open(threadRef, "super-thread");
}

export function toggleSuperThreadPanel(threadRef: ScopedThreadRef) {
  useRightPanelStore.getState().toggle(threadRef, "super-thread");
}
