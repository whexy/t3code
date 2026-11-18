import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  superThreadMemberNeedsYou,
  type SuperThreadSection,
} from "@t3tools/client-runtime/state/super-threads";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { useDeviceType } from "../../native/native-layout-metrics";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useProjects } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  STATUS_LABEL_BY_STATUS,
  ThreadListV2Section,
  type StatusLabel,
} from "../threads/thread-list-v2-items";
import { SuperThreadMemberRows, type SuperThreadMemberRowHost } from "./SuperThreadMemberRows";
import { openSuperThread, useReportOpenSuperThreadTitle } from "./superThreadLevel";
import { resolveSuperThreadRollup, type SuperThreadRollup } from "./superThreadList";

const DONE: StatusLabel = {
  label: "Done",
  icon: "checkmark.circle",
  className: "text-adaptive-emerald-700-300",
  iconTintClassName: "accent-adaptive-emerald-700-300",
};

// The list's own words and icons; working and waiting get words, as there is no run timer to show.
function rollupLabel(rollup: SuperThreadRollup): StatusLabel | null {
  if (rollup === null) return null;
  if (rollup === "done") return DONE;
  const label = STATUS_LABEL_BY_STATUS[rollup]!;
  if (rollup === "working") return { ...label, label: "Working" };
  if (rollup === "waiting") return { ...label, label: "Waiting" };
  return label;
}

const threadCount = (count: number) => (count === 1 ? "1 thread" : `${count} threads`);

/** How many threads a super thread started, and how many of them need the person. */
function summary(rows: ReadonlyArray<EnvironmentThreadShell>) {
  const needsYou = rows.filter(superThreadMemberNeedsYou).length;
  return needsYou > 0
    ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} you · ${threadCount(rows.length)}`
    : threadCount(rows.length);
}

/**
 * The list's super threads, as its own rows under one heading, so they swipe to settle and open
 * the same menu as any thread. Opening one shows its threads in place of the list, one level down,
 * so a super thread and its threads never share a level. See docs/internals/super-threads.md.
 */
export function SuperThreadListSections(props: {
  readonly list: {
    readonly sections: ReadonlyArray<SuperThreadSection<EnvironmentThreadShell>>;
    /** The super thread whose threads show in place of the list, one level down. */
    readonly open: SuperThreadSection<EnvironmentThreadShell> | null;
    readonly hasOwnRows: boolean;
  };
  readonly pane: "screen" | "sidebar";
  /** The screen's native bar names the open super thread and leads back, so the list doesn't. */
  readonly headerInBar?: boolean;
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly memberRowHost: SuperThreadMemberRowHost;
}) {
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  // The folded Duo's workspace bar carries this back button instead.
  const backInBar = useDeviceType() === "duo-folded";
  const open = props.list.open;
  useReportOpenSuperThreadTitle(props.headerInBar && open !== null ? open.header.title : null);
  if (props.list.sections.length === 0) return null;
  const sidebar = props.pane === "sidebar";
  const projectByKey = new Map(
    projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project]),
  );
  const rowProps = {
    projectByKey,
    pane: props.pane,
    selectedThreadKey: props.selectedThreadKey,
    host: props.memberRowHost,
  };

  if (props.list.open !== null) {
    const { header, rows } = props.list.open;
    const showEnvironment = rows.some((row) => row.environmentId !== header.environmentId);
    return (
      <View className="pb-2">
        {props.headerInBar ? (
          // The bar only names the level, so the super thread stays a row to open it from.
          <>
            <SuperThreadMemberRows
              {...rowProps}
              rows={[header]}
              hints={new Map([[scopedThreadKey(header.environmentId, header.id), summary(rows)]])}
              showEnvironment={false}
              statusOverrides={
                new Map([
                  [
                    scopedThreadKey(header.environmentId, header.id),
                    rollupLabel(resolveSuperThreadRollup(header, rows)),
                  ],
                ])
              }
              onSelectThread={props.onSelectThread}
            />
            {rows.length > 0 ? (
              <View className={sidebar ? "px-2" : undefined}>
                <ThreadListV2Section label="Threads" pane={props.pane} />
              </View>
            ) : null}
          </>
        ) : (
          <View className={cn("gap-0.5 pt-1 pb-3", sidebar ? "px-4" : "px-5")}>
            {backInBar ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back to super threads"
                hitSlop={8}
                onPress={() => openSuperThread(null)}
                className="min-h-8 flex-row items-center gap-1 self-start"
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <SymbolView name="chevron.left" size={14} tintColorClassName="accent-primary" />
                <Text className="text-base text-primary">Super threads</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${header.title}`}
              onPress={() => props.onSelectThread(header)}
              className="flex-row items-center gap-2"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <View className="flex-1 gap-0.5">
                <Text
                  numberOfLines={2}
                  className={cn(
                    "text-lg font-t3-bold leading-snug",
                    sidebar ? "text-drawer-foreground" : "text-foreground",
                  )}
                >
                  {header.title}
                </Text>
                <Text
                  className={cn(
                    "text-xs",
                    sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted",
                  )}
                >
                  {summary(rows)}
                </Text>
              </View>
              <SymbolView
                name="chevron.right"
                size={13}
                tintColorClassName={
                  sidebar ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
                }
              />
            </Pressable>
          </View>
        )}
        {rows.length > 0 ? (
          <SuperThreadMemberRows
            {...rowProps}
            rows={rows}
            hints={
              new Map(
                rows.map((row) => [
                  scopedThreadKey(row.environmentId, row.id),
                  [
                    projectByKey.get(scopedProjectKey(row.environmentId, row.projectId))?.title,
                    showEnvironment
                      ? savedConnectionsById[row.environmentId]?.environmentLabel
                      : undefined,
                  ]
                    .filter((part): part is string => !!part)
                    .join(" · "),
                ]),
              )
            }
            showEnvironment={showEnvironment}
            onSelectThread={props.onSelectThread}
          />
        ) : (
          <Text
            className={cn(
              "py-3 text-sm",
              sidebar ? "px-3 text-drawer-foreground-muted" : "px-5 text-foreground-muted",
            )}
          >
            Threads the super thread starts show up here.
          </Text>
        )}
      </View>
    );
  }

  const headers = props.list.sections.map(({ header }) => header);
  return (
    <View className={props.list.hasOwnRows ? undefined : "pb-2"}>
      {/* The sidebar insets its own shelf headings by the list's padding. */}
      <View className={sidebar ? "px-2" : undefined}>
        <ThreadListV2Section label="Super threads" pane={props.pane} />
      </View>
      <SuperThreadMemberRows
        {...rowProps}
        rows={headers}
        // A super thread has no project, so its line says what it holds instead.
        hints={
          new Map(
            props.list.sections.map(({ header, rows }) => [
              scopedThreadKey(header.environmentId, header.id),
              summary(rows),
            ]),
          )
        }
        showEnvironment={false}
        // The group's status, not only the super thread's own run.
        statusOverrides={
          new Map(
            props.list.sections.map(({ header, rows }) => [
              scopedThreadKey(header.environmentId, header.id),
              rollupLabel(resolveSuperThreadRollup(header, rows)),
            ]),
          )
        }
        onSelectThread={(header) => {
          openSuperThread(scopedThreadKey(header.environmentId, header.id));
          props.onSelectThread(header);
        }}
      />
      {/* Ends the group, so the list's own threads don't read as its members. */}
      {props.list.hasOwnRows ? (
        <View className={sidebar ? "px-2" : undefined}>
          <ThreadListV2Section label="Threads" pane={props.pane} />
        </View>
      ) : null}
    </View>
  );
}
