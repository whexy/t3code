import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { superThreadMapChangesSince } from "@t3tools/client-runtime/state/super-thread-map";
import type {
  ScopedThreadRef,
  SuperThreadMap as SuperThreadMapState,
  SuperThreadMember,
} from "@t3tools/contracts";
import { use, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetPane } from "../../components/ui/SheetPane";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspacePaneState } from "../layout/AdaptiveWorkspaceLayout";
import { InspectorSheetContext } from "../layout/workspace-inspector-sheet";
import { SuperThreadMap } from "./SuperThreadMap";
import { SuperThreadMapFullScreen } from "./SuperThreadMapFullScreen";
import { MemberRow, SuperThreadNodeDetail } from "./SuperThreadNodeDetail";
import { useSuperThreadPanelLook } from "./superThreadPanelSeen";

/** The super thread's panel beside its conversation: goal, what changed, the map, the rest. */
export function SuperThreadPanel(props: {
  readonly threadRef: ScopedThreadRef;
  /** Whether this is the inspector's chosen pane; it is on screen while the pane is shown. */
  readonly active: boolean;
  readonly onOpenThread: (thread: SuperThreadMember) => void;
}) {
  const shell = useThreadShell(props.threadRef);
  const { panes } = useWorkspacePaneState();
  // A sheet is mounted only while open; a column keeps its panes mounted while hidden.
  const inSheet = use(InspectorSheetContext) !== null;
  const seenAt = useSuperThreadPanelLook(
    shell?.source.superThread === undefined
      ? null
      : scopedThreadKey(props.threadRef.environmentId, props.threadRef.threadId),
    props.active && (inSheet || panes.auxiliaryPaneVisible),
  );
  const detail = useQuietThreadStructure(props.threadRef);
  const [shownNodeId, setShownNodeId] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const superThread = detail?.projection.thread.superThread;
  const members = superThread?.members ?? shell?.source.superThread?.members ?? [];
  const map = superThread?.map ?? null;
  const shownNode = map?.nodes.find((node) => node.id === shownNodeId) ?? null;
  const since = map === null ? null : superThreadMapChangesSince(map, seenAt);

  return (
    <SheetPane>
      <AppBar
        title={shownNode?.title ?? "Super thread"}
        subtitle={shownNode === null ? shell?.title : undefined}
        actions={
          shownNode === null && map !== null && map.nodes.length > 0
            ? [
                {
                  accessibilityLabel: "Open the map full screen",
                  icon: "arrow.up.left.and.arrow.down.right",
                  onPress: () => setFullScreen(true),
                },
              ]
            : []
        }
      />
      <ScreenContent>
        <ScrollView
          className="flex-1"
          accessibilityElementsHidden={shownNode !== null}
          importantForAccessibility={shownNode === null ? "auto" : "no-hide-descendants"}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ gap: 20, padding: 16, paddingBottom: 32 }}
        >
          {shell !== null && shell.source.superThread === undefined ? (
            <EmptyState
              variant="plain"
              title="Not a super thread"
              detail="This thread has no task map."
            />
          ) : (
            <>
              <View className="gap-1.5 px-2">
                <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
                  Goal
                </Text>
                {map !== null && map.goal.trim().length > 0 ? (
                  <SuperThreadGoal goal={map.goal} />
                ) : (
                  <Text className="text-sm text-foreground-muted">
                    {detail === null
                      ? "Loading the plan…"
                      : "No goal yet. The agent writes it once it has a plan."}
                  </Text>
                )}
              </View>
              {since !== null && since.changes.length > 0 ? (
                <View className="gap-1 rounded-2xl bg-grouped-card p-4">
                  <Text className="text-sm font-t3-medium text-foreground">
                    {since.changes.length === 1
                      ? "The plan changed since you looked"
                      : `The plan changed ${since.changes.length} times since you looked`}
                  </Text>
                  {since.changes.map((change) => (
                    <Text
                      key={change.revision}
                      selectable
                      className="text-sm text-foreground-muted"
                    >
                      {change.reason}
                      {change.removed.length > 0
                        ? ` · removed ${change.removed.map((node) => `"${node.title}"`).join(", ")}`
                        : ""}
                    </Text>
                  ))}
                </View>
              ) : null}
              {map !== null && since !== null ? (
                <View className="gap-2">
                  <Text textRole="footnote" className="px-2 font-t3-medium text-foreground-muted">
                    Task map
                  </Text>
                  <SuperThreadMap
                    map={map}
                    addedNodeIds={since.addedNodeIds}
                    onOpenThread={props.onOpenThread}
                    onShowNode={setShownNodeId}
                  />
                </View>
              ) : null}
              <SuperThreadMembers
                members={map === null ? members : membersNotOnMap(members, map)}
                title={map === null ? "Threads" : "Not on the map"}
                onOpen={props.onOpenThread}
              />
            </>
          )}
        </ScrollView>
        {/* Covers the map rather than replacing it, so the map keeps its zoom and scroll. */}
        {shownNode !== null && map !== null ? (
          <View className="absolute inset-0 bg-sheet-solid">
            <ScrollView
              className="flex-1"
              contentInsetAdjustmentBehavior="automatic"
              contentContainerStyle={{ gap: 16, padding: 16, paddingBottom: 32 }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back to the map"
                onPress={() => setShownNodeId(null)}
                className="min-h-11 flex-row items-center gap-1 self-start px-1"
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <SymbolView name="chevron.left" size={14} tintColorClassName="accent-primary" />
                <Text className="text-base text-primary">Map</Text>
              </Pressable>
              <SuperThreadNodeDetail node={shownNode} map={map} onOpenThread={props.onOpenThread} />
            </ScrollView>
          </View>
        ) : null}
        {map !== null ? (
          <SuperThreadMapFullScreen
            visible={fullScreen}
            title={shell?.title ?? "Super thread"}
            map={map}
            addedNodeIds={since?.addedNodeIds ?? new Set()}
            onClose={() => setFullScreen(false)}
            onOpenThread={props.onOpenThread}
          />
        ) : null}
      </ScreenContent>
    </SheetPane>
  );
}

const GOAL_LINES = 3;

/** Long goals fold to a few lines, like long messages in the conversation. */
function SuperThreadGoal(props: { readonly goal: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  return (
    <View className="items-start gap-1">
      {/* Measures the whole goal unclamped; a clamped Text reports only the lines it shows. */}
      <Text
        textRole="body"
        aria-hidden
        pointerEvents="none"
        className="absolute inset-x-0 top-0 opacity-0"
        onTextLayout={(event) => setClamped(event.nativeEvent.lines.length > GOAL_LINES)}
      >
        {props.goal}
      </Text>
      <Text
        selectable
        textRole="body"
        className="text-foreground"
        numberOfLines={expanded ? undefined : GOAL_LINES}
      >
        {props.goal}
      </Text>
      {clamped ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setExpanded(!expanded)}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text textRole="footnote" className="font-t3-medium text-primary">
            {expanded ? "Show less" : "Show full goal"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function membersNotOnMap(
  members: ReadonlyArray<SuperThreadMember>,
  map: SuperThreadMapState,
): ReadonlyArray<SuperThreadMember> {
  const onMap = new Set(
    map.nodes.flatMap((node) =>
      (node.threads ?? []).map((thread) => scopedThreadKey(thread.environmentId, thread.threadId)),
    ),
  );
  return members.filter(
    (member) => !onMap.has(scopedThreadKey(member.environmentId, member.threadId)),
  );
}

/** Every member this client holds, settled ones included; the list shows only unsettled ones. */
function SuperThreadMembers(props: {
  readonly members: ReadonlyArray<SuperThreadMember>;
  readonly title: "Threads" | "Not on the map";
  readonly onOpen: (member: SuperThreadMember) => void;
}) {
  const shells = useThreadShells();
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  if (props.members.length === 0) {
    if (props.title === "Not on the map") return null;
    return (
      <ListSection title="Threads">
        <Text className="p-4 text-sm text-foreground-muted">
          Threads the agent launches show up here and in the thread list.
        </Text>
      </ListSection>
    );
  }
  const shellByKey = new Map(
    shells.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell]),
  );
  const projectTitleByKey = new Map(
    projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project.title]),
  );
  const held = props.members.flatMap((member): EnvironmentThreadShell[] => {
    const shell = shellByKey.get(scopedThreadKey(member.environmentId, member.threadId));
    return shell === undefined || shell.deletedAt !== null ? [] : [shell];
  });
  const missing = props.members.length - held.length;
  return (
    <ListSection
      title={props.title}
      footer={
        missing > 0
          ? `${missing} more on environments this device can't reach right now.`
          : undefined
      }
    >
      {held.map((shell, index) => (
        <MemberRow
          key={scopedThreadKey(shell.environmentId, shell.id)}
          shell={shell}
          hint={[
            projectTitleByKey.get(scopedProjectKey(shell.environmentId, shell.projectId)),
            savedConnectionsById[shell.environmentId]?.environmentLabel,
          ]
            .filter((part): part is string => !!part)
            .join(" · ")}
          first={index === 0}
          onOpen={props.onOpen}
        />
      ))}
    </ListSection>
  );
}
