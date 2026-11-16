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
import { SuperThreadStatus } from "./SuperThreadStatus";

/** One group per super thread above the list's own shelves; see docs/internals/super-threads.md. */
export function SuperThreadListSections(props: {
  readonly sections: ReadonlyArray<SuperThreadSection<EnvironmentThreadShell>>;
  readonly pane: "screen" | "sidebar";
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  /** Settles the group; the thread actions ask first and settle the members too. */
  readonly onSettleThread: (thread: EnvironmentThreadShell) => unknown;
}) {
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  if (props.sections.length === 0) return null;
  const sidebar = props.pane === "sidebar";
  const foreground = sidebar ? "text-drawer-foreground" : "text-foreground";
  const muted = sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted";
  const projectTitleByKey = new Map(
    projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project.title]),
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
                accessibilityHint="Opens its task map and threads"
                onPress={() =>
                  selectDetail({
                    name: "SuperThread",
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
            {rows.map((row) => {
              const rowKey = scopedThreadKey(row.environmentId, row.id);
              const hint = [
                projectTitleByKey.get(scopedProjectKey(row.environmentId, row.projectId)),
                showEnvironment
                  ? savedConnectionsById[row.environmentId]?.environmentLabel
                  : undefined,
              ]
                .filter((part): part is string => !!part)
                .join(" · ");
              return (
                <Pressable
                  key={rowKey}
                  accessibilityRole="button"
                  accessibilityLabel={hint ? `${row.title}, ${hint}` : row.title}
                  onPress={() => props.onSelectThread(row)}
                  // Lines member titles up with the header title, past its icon.
                  className={cn(
                    rowClassName(props.selectedThreadKey === rowKey),
                    sidebar ? "pl-[30px]" : "pl-[38px]",
                  )}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <View className="min-w-0 flex-1">
                    <Text className={cn("text-base font-t3-medium", foreground)} numberOfLines={2}>
                      {row.title}
                    </Text>
                    {hint ? (
                      <Text className={cn("mt-0.5 text-xs", muted)} numberOfLines={1}>
                        {hint}
                      </Text>
                    ) : null}
                  </View>
                  <SuperThreadStatus thread={row} />
                </Pressable>
              );
            })}
          </View>
        );
      })}
      <View className={cn("mx-4 h-px", sidebar ? "bg-drawer-border" : "bg-border")} />
    </View>
  );
}
