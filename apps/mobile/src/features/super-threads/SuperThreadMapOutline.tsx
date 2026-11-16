import {
  SUPER_THREAD_MAP_STATE_LABELS,
  layoutSuperThreadMap,
  resolveSuperThreadMapNodeState,
  superThreadMapChangesSince,
  type SuperThreadMapNodeState,
} from "@t3tools/client-runtime/state/super-thread-map";
import type { SuperThreadMap, SuperThreadMember } from "@t3tools/contracts";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { ListSection } from "../../components/ui/ListSection";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadShells } from "../../state/entities";

const STATE_PRESENTATION: Record<
  SuperThreadMapNodeState,
  { readonly icon: AppSymbolName; readonly className: string; readonly tint: string }
> = {
  "needs-you": {
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    tint: "accent-adaptive-indigo-600-300",
  },
  failed: {
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    tint: "accent-danger-foreground",
  },
  dropped: {
    icon: "slash.circle",
    className: "text-foreground-muted",
    tint: "accent-foreground-muted",
  },
  working: {
    icon: "circle.dashed",
    className: "text-adaptive-sky-600-400",
    tint: "accent-adaptive-sky-600-400",
  },
  blocked: {
    icon: "exclamationmark.triangle",
    className: "text-warning-foreground",
    tint: "accent-warning-foreground",
  },
  done: {
    icon: "checkmark.circle",
    className: "text-adaptive-emerald-700-300",
    tint: "accent-adaptive-emerald-700-300",
  },
  active: {
    icon: "circle.inset.filled",
    className: "text-adaptive-sky-600-400",
    tint: "accent-adaptive-sky-600-400",
  },
  planned: { icon: "circle", className: "text-foreground-muted", tint: "accent-foreground-muted" },
};

/** The task map at phone width: one section per lane, nodes in the map's reading order. */
export function SuperThreadMapOutline(props: {
  readonly map: SuperThreadMap;
  /** When the person last looked before opening the page. */
  readonly seenAt: string | null | undefined;
  readonly onOpen: (member: SuperThreadMember) => void;
}) {
  const { map } = props;
  const shells = useThreadShells();
  const layout = useMemo(() => layoutSuperThreadMap(map), [map]);
  if (map.nodes.length === 0) {
    return (
      <Text className="px-2 text-sm text-foreground-muted">
        The agent has not drawn any work yet.
      </Text>
    );
  }
  const since = superThreadMapChangesSince(map, props.seenAt);
  const shellByKey = new Map(
    shells.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell]),
  );
  const titleById = new Map(map.nodes.map((node) => [node.id, node.title]));
  const after = new Map<string, Array<string>>();
  for (const edge of map.edges) {
    if (edge.kind !== "depends") continue;
    after.set(edge.to, [...(after.get(edge.to) ?? []), titleById.get(edge.from) ?? edge.from]);
  }
  return (
    <>
      {since.changes.length > 0 ? (
        <View className="gap-1 rounded-2xl bg-grouped-card p-4">
          <Text className="text-sm font-t3-medium text-foreground">
            {since.changes.length === 1
              ? "The plan changed since you looked"
              : `The plan changed ${since.changes.length} times since you looked`}
          </Text>
          {since.changes.map((change) => (
            <Text key={change.revision} selectable className="text-sm text-foreground-muted">
              {change.reason}
              {change.removed.length > 0
                ? ` · removed ${change.removed.map((node) => `"${node.title}"`).join(", ")}`
                : ""}
            </Text>
          ))}
        </View>
      ) : null}
      {layout.lanes.map((lane) => {
        const nodes = layout.nodes.filter(({ node }) => (node.group ?? null) === lane.group);
        return (
          <ListSection key={lane.group ?? ""} title={lane.group ?? "Map"}>
            {nodes.map(({ node }, index) => {
              const threads = node.threads ?? [];
              const linked = threads.map(
                (thread) =>
                  shellByKey.get(scopedThreadKey(thread.environmentId, thread.threadId)) ?? null,
              );
              const { state, unreachable } = resolveSuperThreadMapNodeState(node.status, linked);
              const presentation = STATE_PRESENTATION[state];
              const prerequisites = after.get(node.id);
              return (
                <View
                  key={node.id}
                  className={cn("gap-1 p-4", index > 0 && "border-t border-border-subtle")}
                >
                  <View className="flex-row items-center gap-1">
                    <SymbolView
                      name={presentation.icon}
                      size={11}
                      tintColorClassName={presentation.tint}
                      type="monochrome"
                    />
                    <Text className={cn("text-xs font-t3-medium", presentation.className)}>
                      {SUPER_THREAD_MAP_STATE_LABELS[state]}
                      {unreachable ? " · a thread can't be reached" : ""}
                    </Text>
                    {since.addedNodeIds.has(node.id) ? (
                      <Text className="text-xs font-t3-medium text-primary">· New</Text>
                    ) : null}
                  </View>
                  <Text
                    className={cn(
                      "text-base font-t3-medium text-foreground",
                      state === "dropped" && "text-foreground-muted line-through",
                    )}
                  >
                    {node.title}
                  </Text>
                  {prerequisites !== undefined ? (
                    <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                      After {prerequisites.join(", ")}
                    </Text>
                  ) : null}
                  {node.note ? (
                    <Text selectable className="text-sm text-foreground">
                      {node.note}
                    </Text>
                  ) : null}
                  {node.detail ? (
                    <Text selectable className="text-sm text-foreground-muted">
                      {node.detail}
                    </Text>
                  ) : null}
                  {threads.map((thread, threadIndex) => (
                    <Pressable
                      key={scopedThreadKey(thread.environmentId, thread.threadId)}
                      accessibilityRole="link"
                      onPress={() => props.onOpen(thread)}
                      className="min-h-11 justify-center"
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                    >
                      <Text className="text-sm text-primary" numberOfLines={1}>
                        {linked[threadIndex]?.title ?? "Open thread"}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              );
            })}
          </ListSection>
        );
      })}
    </>
  );
}
