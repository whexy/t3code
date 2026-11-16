import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";

import type { NewThreadHandler } from "../../hooks/useHandleNewThread";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { startSuperThreadDraft } from "./superThreadDrafts";
import { openSuperThreadPanel } from "./superThreadPanelActions";

export function newSuperThreadPaletteAction(
  environmentId: EnvironmentId,
  handleNewThread: NewThreadHandler,
): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:new-super-thread",
    searchTerms: ["new super thread", "coordinate", "task map", "across projects"],
    title: "New super thread",
    icon: <NetworkIcon className={ITEM_ICON_CLASS} />,
    run: () => startSuperThreadDraft(environmentId, handleNewThread),
  };
}

/** Opens the open super thread's goal and task map; nothing for other threads. */
export function superThreadPanelPaletteActions(
  thread: EnvironmentThreadShell | null,
): ReadonlyArray<CommandPaletteActionItem> {
  if (thread?.source.superThread === undefined) return [];
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  return [
    {
      kind: "action",
      value: "action:show-super-thread-panel",
      searchTerms: ["super thread", "goal", "task map", "plan", "progress"],
      title: "Show goal and task map",
      icon: <NetworkIcon className={ITEM_ICON_CLASS} />,
      run: async () => openSuperThreadPanel(threadRef),
    },
  ];
}
