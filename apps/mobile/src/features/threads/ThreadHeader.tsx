import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import { environmentThreadShells } from "../../state/threads";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { describeSideChatsAwaitingUser } from "./sideChatsStatus";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  /** Absent where this thread cannot have side chats. */
  readonly sideChats?: { readonly thread: ScopedThreadRef; readonly onOpen: () => void };
}) {
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const sideChatsVisible = props.inspectorMode === "sideChats" && panes.auxiliaryPaneVisible;
  const sideChatsStatus = useSideChatsStatus(props.sideChats?.thread ?? null);
  const panelItems: AppBarMenuItem[] = [
    ...(props.hasThreadCwd
      ? [
          {
            id: "files",
            title: "Files",
            icon: "folder",
            selected: filesVisible,
            disabled: !props.gitControls.canOpenFiles,
            onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
          },
        ]
      : []),
    ...(props.sideChats
      ? [
          {
            id: "side-chats",
            title: "Side chats",
            icon: "bubble.left.and.bubble.right",
            ...(sideChatsStatus === null ? {} : { subtitle: sideChatsStatus }),
            selected: sideChatsVisible,
            onPress: sideChatsVisible ? toggleAuxiliaryPane : props.sideChats.onOpen,
          },
        ]
      : []),
  ];
  // Panels open beside the thread, so they share one button instead of one each.
  const panelsMenu: AppBarMenu | null =
    panelItems.length === 0
      ? null
      : {
          title: "Panels",
          icon: "sidebar.right",
          separateBackground: false,
          ...(sideChatsStatus === null ? {} : { status: sideChatsStatus }),
          items: panelItems,
        };
  // iOS lays out trailing items from the edge inward, so the first menu sits outermost.
  const menus = [panelsMenu, gitMenu, terminalMenu].filter(
    (menu): menu is AppBarMenu => menu !== null,
  );

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      menus={menus}
      hideBottomBorder
    />
  );
}

const NO_SIDE_CHATS_ATOM = Atom.make<ReadonlyArray<EnvironmentThreadShell>>([]).pipe(
  Atom.withLabel("mobile-thread-header-side-chats:none"),
);

function useSideChatsStatus(ref: ScopedThreadRef | null): string | null {
  const sideChats = useAtomValue(
    ref === null ? NO_SIDE_CHATS_ATOM : environmentThreadShells.sideChatsAtom(ref),
  );
  return describeSideChatsAwaitingUser(sideChats);
}
