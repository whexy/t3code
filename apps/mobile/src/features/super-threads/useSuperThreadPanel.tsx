import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { InspectorPane } from "../layout/inspector-panes";
import { InspectorSheetContext } from "../layout/workspace-inspector-sheet";
import type { ThreadInspectorMode } from "../threads/thread-inspector-navigation";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";
import { SuperThreadPanel } from "./SuperThreadPanel";

/** A super thread's conversation gets the map as a panel beside it, like Files and Side chats. */
export function useSuperThreadPanel(props: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "source"> | null;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly choose: (mode: ThreadInspectorMode) => void;
}): {
  readonly items: ReadonlyArray<AppBarMenuItem>;
  readonly panes: ReadonlyArray<InspectorPane>;
} {
  const { thread } = props;
  const navigation = useNavigation();
  const { showInspector, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const openLinkedThread = useOpenLinkedThread();
  const visible = props.inspectorMode === "superThread" && panes.auxiliaryPaneVisible;
  if (thread === null) return { items: [], panes: [] };
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  return {
    // The pane stays for any thread, so switching to a plain thread with it open shows why it's empty.
    items:
      thread.source.superThread === undefined
        ? []
        : [
            {
              id: "super-thread",
              title: "Super thread",
              icon: "point.3.connected.trianglepath.dotted",
              selected: visible,
              onPress: visible
                ? toggleAuxiliaryPane
                : () => {
                    navigation.setParams({ inspector: undefined });
                    props.choose("superThread");
                    showInspector();
                  },
            },
          ],
    panes: [
      {
        key: "superThread",
        render: () => (
          <InspectorSheetContext.Consumer>
            {(closeInspectorSheet) => (
              <SuperThreadPanel
                threadRef={threadRef}
                active={props.inspectorMode === "superThread"}
                onOpenThread={(member) =>
                  // A sheet closes before the thread opens over it; a column stays beside it.
                  closeInspectorSheet
                    ? closeInspectorSheet(() => openLinkedThread(member))
                    : openLinkedThread(member)
                }
              />
            )}
          </InspectorSheetContext.Consumer>
        ),
      },
    ],
  };
}
