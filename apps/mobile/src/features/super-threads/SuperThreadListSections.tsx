import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { SuperThreadSection } from "@t3tools/client-runtime/state/super-threads";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useProjects } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SuperThreadMemberRows, type SuperThreadMemberRowHost } from "./SuperThreadMemberRows";
import { SuperThreadStatus } from "./SuperThreadStatus";

/** One group per super thread above the list's own shelves; see docs/internals/super-threads.md. */
export function SuperThreadListSections(props: {
  readonly sections: ReadonlyArray<SuperThreadSection<EnvironmentThreadShell>>;
  readonly pane: "screen" | "sidebar";
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  /** Settles the group; the thread actions ask first and settle the members too. */
  readonly onSettleThread: (thread: EnvironmentThreadShell) => unknown;
  readonly memberRowHost: SuperThreadMemberRowHost;
}) {
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  if (props.sections.length === 0) return null;
  const sidebar = props.pane === "sidebar";
  const foreground = sidebar ? "text-drawer-foreground" : "text-foreground";
  const projectByKey = new Map(
    projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project]),
  );
  const memberHints = (
    rows: ReadonlyArray<EnvironmentThreadShell>,
    showEnvironment: boolean,
  ): ReadonlyMap<string, string> =>
    new Map(
      rows.map((row) => [
        scopedThreadKey(row.environmentId, row.id),
        [
          projectByKey.get(scopedProjectKey(row.environmentId, row.projectId))?.title,
          showEnvironment ? savedConnectionsById[row.environmentId]?.environmentLabel : undefined,
        ]
          .filter((part): part is string => !!part)
          .join(" · "),
      ]),
    );
  const rowClassName = (selected: boolean) =>
    cn(
      "min-h-11 flex-row items-center gap-2.5 rounded-xl py-2",
      sidebar ? "px-2" : "px-4",
      selected && (sidebar ? "bg-drawer-border" : "bg-primary/10"),
    );

  return (
    <View className={cn("gap-3 pb-3", sidebar ? "pt-1" : "pt-2")}>
      {props.sections.map(({ header, rows }) => {
        const headerKey = scopedThreadKey(header.environmentId, header.id);
        const showEnvironment = rows.some((row) => row.environmentId !== header.environmentId);
        const headerSettled = header.settledOverride === "settled";
        return (
          <View key={headerKey} testID="super-thread-section">
            <View className="flex-row items-center">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${header.title}, super thread`}
                onPress={() =>
                  selectDetail({
                    name: "Thread",
                    params: { environmentId: header.environmentId, threadId: header.id },
                  })
                }
                className={cn(
                  "min-w-0 flex-1",
                  rowClassName(props.selectedThreadKey === headerKey),
                  "pr-1",
                )}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <SymbolView
                  name="point.3.connected.trianglepath.dotted"
                  size={15}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
                <Text
                  className={cn("min-w-0 flex-1 text-base font-t3-bold", foreground)}
                  numberOfLines={2}
                >
                  {header.title}
                </Text>
                <SuperThreadStatus thread={header} />
              </Pressable>
              {headerSettled ? null : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Settle ${header.title} and its threads`}
                  hitSlop={8}
                  onPress={() => void props.onSettleThread(header)}
                  className={cn("h-11 w-10 items-center justify-center", !sidebar && "mr-1.5")}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <SymbolView
                    name="checkmark.circle"
                    size={18}
                    tintColorClassName="accent-icon-muted"
                    type="monochrome"
                  />
                </Pressable>
              )}
            </View>
            {rows.length > 0 ? (
              // Indents member rows under the header title, past its icon.
              <View className="pl-5">
                <SuperThreadMemberRows
                  rows={rows}
                  hints={memberHints(rows, showEnvironment)}
                  showEnvironment={showEnvironment}
                  projectByKey={projectByKey}
                  pane={props.pane}
                  selectedThreadKey={props.selectedThreadKey}
                  onSelectThread={props.onSelectThread}
                  host={props.memberRowHost}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      <View className={cn("mx-4 h-px", sidebar ? "bg-drawer-border" : "bg-border")} />
    </View>
  );
}
