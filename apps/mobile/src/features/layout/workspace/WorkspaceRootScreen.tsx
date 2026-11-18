import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { isSharedSlotTab } from "./navigation-tab-order";
import { SharedSlotTitle } from "./SharedSlotTitle";
import { WORKSPACE_TAB_LABELS, useEnabledNavigationTabs } from "./navigation-tabs";
import { WorkspaceExtraTab } from "./WorkspaceExtraTab";
import { WorkspaceSettingsList } from "../../settings/SettingsRouteScreen";
import { WorkspaceSectionToolbar } from "./WorkspaceSectionToolbar";
import { useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { use } from "react";
import { View, useWindowDimensions } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { CompactBrandTitle } from "../../../components/CompactBrandTitle";
import { HeaderItemsWidthContext } from "../../../native/header-items-width";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import {
  NativePrimaryColumnContext,
  NativeWorkspaceTabActivityContext,
} from "../../../native/v5-workspace-context";
import { isDuoDevice } from "../../../lib/device-type";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../../native/native-glass";
import {
  useDeviceType,
  useNativeColumnLayoutMetrics,
  useNativeLayoutMetrics,
} from "../../../native/native-layout-metrics";
import { HomeRouteScreen } from "../../home/HomeRouteScreen";
import { WorkspaceConnectionTitle } from "../../home/WorkspaceConnectionTitle";
import { useAdaptiveWorkspaceLayout } from "../AdaptiveWorkspaceLayout";
import { PullRequestsScreen } from "../../pull-requests/PullRequestsScreen";
import { IssuesScreen } from "../../issues/IssuesScreen";
import {
  WorkspaceTabsContext,
  WorkspaceTabsProvider,
  useWorkspaceTabs,
} from "./WorkspaceTabsContext";
import { WorkspaceToolbar } from "./WorkspaceToolbar";
import {
  WORKSPACE_DOCK,
  workspaceDockBottomClearance,
  workspaceUsesColumns,
} from "./workspace-tabs-state";
import { WorkspaceTabDock } from "./WorkspaceTabDock";
import {
  useCompactWorkspaceTabs,
  useSidebarWorkspaceTabs,
  useSystemWorkspaceTabBar,
} from "./useSystemWorkspaceTabBar";
import { openSettings } from "../../settings/settings-navigation";
import { openSuperThread, useOpenSuperThreadTitle } from "../../super-threads/superThreadLevel";
import { withNativeGlassHeaderItem } from "../native-glass-header-items";

const TAB_TITLES = WORKSPACE_TAB_LABELS;

function WorkspaceRootTitle(props: {
  readonly columnWidth: number;
  readonly onOpenEnvironments: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { state, settingsOpen } = useWorkspaceTabs()!;
  const maxWidth = Math.max(0, props.columnWidth - (use(HeaderItemsWidthContext) ?? 160));
  const enabled = useEnabledNavigationTabs();
  const tabTitle = settingsOpen
    ? gt("Settings")
    : enabled.length
      ? m(TAB_TITLES[state.selectedTab])
      : gt("Navigation", { $context: "screen title when every navigation tab is hidden" });
  return (
    <View style={{ width: maxWidth, minHeight: 32, justifyContent: "center" }}>
      <WorkspaceConnectionTitle
        brand={
          !settingsOpen && isSharedSlotTab(state.selectedTab) ? (
            <SharedSlotTitle tab={state.selectedTab} />
          ) : (
            <CompactBrandTitle
              accessibilityLabel={gt("{product}, {title}", { product: "T3 Code", title: tabTitle })}
              fit
            />
          )
        }
        maxWidth={maxWidth}
        onPress={props.onOpenEnvironments}
      />
    </View>
  );
}

const SUPER_THREAD_BACK_ITEM = withNativeGlassHeaderItem({
  type: "button" as const,
  label: "",
  accessibilityLabel: "Back to super threads",
  icon: { type: "sfSymbol" as const, name: "chevron.left" as never },
  onPress: () => openSuperThread(null),
});

function WorkspaceRootContent() {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const { width: windowWidth } = useWindowDimensions();
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const primaryColumn = use(NativePrimaryColumnContext);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const nativeMetrics = useNativeLayoutMetrics();
  const deviceType = useDeviceType();
  const systemTabBar = useSystemWorkspaceTabBar();
  const compactTabs = useCompactWorkspaceTabs();
  const enabled = useEnabledNavigationTabs();
  const sidebarTabs = useSidebarWorkspaceTabs();
  const sidebarPicker = sidebarTabs === "picker" || (deviceType === "pad" && layout.usesSplitView);
  const sidebarNavigation =
    primaryColumn !== null &&
    (layout.usesSplitView ||
      deviceType === "pad" ||
      (nativeMetrics !== null && nativeMetrics.verticalBarEdge !== "none"));
  const width = columnMetrics?.width ?? windowWidth;
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardState((keyboard) => keyboard.height);
  const workspace = useWorkspaceTabs()!;
  const { state } = workspace;
  // Settings is a workspace tab too; its list takes the place of the selected tab's.
  const settingsOpen = workspace.settingsOpen;
  const headerOnly = use(NativeWorkspaceTabActivityContext)?.headerOnly === true;
  const openSuperThreadTitle = useOpenSuperThreadTitle();
  // Super thread titles run long, so the bar names the level and carries the title below it.
  const superThreadTitle =
    !settingsOpen && state.selectedTab === "threads" ? openSuperThreadTitle : null;
  const renderHeaderTitle = () => (
    <WorkspaceRootTitle
      columnWidth={width}
      onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
    />
  );
  const tab = state.tabs[settingsOpen ? "settings" : state.selectedTab];
  const bottomClearance =
    layout.variant === "medium" && !workspaceUsesColumns(state.selectedTab)
      ? workspaceDockBottomClearance({ bottomInset: insets.bottom, keyboardHeight })
      : isDuoDevice(deviceType)
        ? // The column's safe area holds the Duo's search toolbar, but not the sidebar's own tab bar.
          Math.max(insets.bottom + (sidebarPicker ? 64 : 0), keyboardHeight) + 16
        : compactTabs || deviceType === "pad"
          ? workspaceDockBottomClearance({ bottomInset: insets.bottom, keyboardHeight })
          : Math.max(insets.bottom, keyboardHeight) +
            (systemTabBar || sidebarTabs || tab.searchMode !== "resting"
              ? sidebarPicker
                ? 80
                : 16
              : WORKSPACE_DOCK.height + WORKSPACE_DOCK.bottomGap + 16);
  const context = { ...workspace, bottomClearance };

  return (
    <WorkspaceTabsContext value={context}>
      <View className={sidebarPicker ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
        <NativeStackScreenOptions
          optionsVersion={[
            settingsOpen,
            state.selectedTab,
            width,
            sidebarNavigation,
            enabled.length,
            superThreadTitle,
          ]}
          options={{
            title:
              superThreadTitle !== null
                ? gt("Super thread")
                : settingsOpen
                  ? gt("Settings")
                  : enabled.length
                    ? m(TAB_TITLES[state.selectedTab])
                    : gt("Navigation", {
                        $context: "screen title when every navigation tab is hidden",
                      }),
            unstable_headerSubtitle: superThreadTitle ?? undefined,
            headerShown: true,
            headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
            headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED
              ? { backgroundColor: "transparent" }
              : undefined,
            contentStyle: undefined,
            ...(enabled.length === 0
              ? { headerSearchBarOptions: undefined, unstable_headerRightItems: () => [] }
              : {}),
            // The folded Duo leads back from its bottom bar instead.
            unstable_headerLeftItems: () =>
              superThreadTitle !== null && deviceType !== "duo-folded"
                ? [SUPER_THREAD_BACK_ITEM]
                : [],
            // Beside a detail column the tab bar names the tab and the detail header the page,
            // so the sidebar keeps the brand.
            headerTitle:
              superThreadTitle !== null
                ? undefined
                : sidebarNavigation || (!settingsOpen && workspaceUsesColumns(state.selectedTab))
                  ? renderHeaderTitle
                  : undefined,
          }}
        />
        <SafeAreaInsetsContext value={compactTabs ? { ...insets, bottom: 0 } : insets}>
          {/* Usage draws its own header, and skips its body itself. */}
          {headerOnly && (settingsOpen || state.selectedTab !== "usage") ? null : settingsOpen ? (
            <WorkspaceSettingsList />
          ) : enabled.length === 0 ? (
            <WorkspaceNoTabs />
          ) : state.selectedTab === "threads" ? (
            <HomeRouteScreen />
          ) : state.selectedTab === "pullRequests" ? (
            <PullRequestsScreen />
          ) : state.selectedTab === "issues" ? (
            <IssuesScreen />
          ) : (
            <WorkspaceExtraTab tab={state.selectedTab} />
          )}
        </SafeAreaInsetsContext>
        {deviceType !== "pad" && deviceType !== "phone" && sidebarPicker ? (
          <WorkspaceTabDock placement="column" />
        ) : null}
        {enabled.length === 0 && !settingsOpen ? null : settingsOpen ||
          workspaceUsesColumns(state.selectedTab) ? (
          <WorkspaceToolbar sidebar={sidebarNavigation} onNewTask={startNewTask} />
        ) : (
          <WorkspaceSectionToolbar onNewTask={startNewTask} showCompose={false} />
        )}
      </View>
    </WorkspaceTabsContext>
  );
}

export function WorkspaceRootScreen() {
  const workspace = useWorkspaceTabs();
  return workspace ? (
    <WorkspaceRootContent />
  ) : (
    <WorkspaceTabsProvider>
      <WorkspaceRootContent />
    </WorkspaceTabsProvider>
  );
}
