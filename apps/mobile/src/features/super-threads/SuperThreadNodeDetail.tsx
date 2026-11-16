import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  SUPER_THREAD_MAP_STATE_LABELS,
  resolveSuperThreadMapNodeState,
} from "@t3tools/client-runtime/state/super-thread-map";
import type { SuperThreadMap, SuperThreadMapNode, SuperThreadMember } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListSection } from "../../components/ui/ListSection";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { STATE_PRESENTATION, useLinkedShells } from "./SuperThreadMap";
import { SuperThreadStatus } from "./SuperThreadStatus";

/** What web's hover card shows: purpose, the agent's note, related work and the node's threads. */
export function SuperThreadNodeDetail(props: {
  readonly node: SuperThreadMapNode;
  readonly map: Pick<SuperThreadMap, "nodes" | "edges">;
  readonly onOpenThread: (thread: SuperThreadMember) => void;
}) {
  const { node } = props;
  const threads = node.threads ?? [];
  const shells = useLinkedShells(node.threads);
  const { state, unreachable } = resolveSuperThreadMapNodeState(node.status, shells);
  const presentation = STATE_PRESENTATION[state];
  return (
    <>
      <View className="gap-2 px-2">
        <View className="flex-row items-center gap-1">
          <SymbolView
            name={presentation.icon}
            size={12}
            tintColorClassName={presentation.tint}
            type="monochrome"
          />
          <Text className={cn("text-sm font-t3-medium", presentation.className)}>
            {SUPER_THREAD_MAP_STATE_LABELS[state]}
            {unreachable ? " · a thread can't be reached" : ""}
          </Text>
        </View>
        {node.detail ? (
          <Text selectable className="text-base text-foreground-muted">
            {node.detail}
          </Text>
        ) : null}
        {node.note ? (
          <Text selectable className="text-base text-foreground">
            {node.note}
          </Text>
        ) : null}
        {!node.detail && !node.note ? (
          <Text className="text-sm text-foreground-muted">The agent added no notes.</Text>
        ) : null}
      </View>
      <RelatedWork node={node} map={props.map} />
      {threads.length > 0 ? (
        <ListSection title={threads.length === 1 ? "Thread" : "Threads"}>
          {threads.map((thread, index) => {
            const linked = shells[index] ?? null;
            return linked === null ? (
              <Text
                key={scopedThreadKey(thread.environmentId, thread.threadId)}
                className={cn(
                  "px-4 py-3 text-sm text-foreground-muted",
                  index > 0 && "border-t border-border-subtle",
                )}
              >
                A thread this device can't reach right now
              </Text>
            ) : (
              <MemberRow
                key={scopedThreadKey(thread.environmentId, thread.threadId)}
                shell={linked}
                hint=""
                first={index === 0}
                onOpen={props.onOpenThread}
              />
            );
          })}
        </ListSection>
      ) : null}
    </>
  );
}

/** The node's edges in words, with the agent's labels, which the map itself leaves out. */
function RelatedWork(props: {
  readonly node: SuperThreadMapNode;
  readonly map: Pick<SuperThreadMap, "nodes" | "edges">;
}) {
  const titleOf = new Map(props.map.nodes.map((node) => [node.id, node.title]));
  const lines = props.map.edges.flatMap((edge) => {
    const other =
      edge.from === props.node.id ? edge.to : edge.to === props.node.id ? edge.from : null;
    const title = other === null ? undefined : titleOf.get(other);
    if (title === undefined) return [];
    const text =
      edge.kind === "relates"
        ? `Related to ${title}`
        : edge.to === props.node.id
          ? `Waits for ${title}`
          : `${title} waits for this`;
    return [{ key: `${edge.from}\u0000${edge.to}`, text, label: edge.label }];
  });
  if (lines.length === 0) return null;
  return (
    <ListSection title="Related work">
      {lines.map((line, index) => (
        <View
          key={line.key}
          className={cn("gap-0.5 px-4 py-3", index > 0 && "border-t border-border-subtle")}
        >
          <Text className="text-base text-foreground">{line.text}</Text>
          {line.label ? <Text className="text-xs text-foreground-muted">{line.label}</Text> : null}
        </View>
      ))}
    </ListSection>
  );
}

export function MemberRow(props: {
  readonly shell: EnvironmentThreadShell;
  readonly hint: string;
  readonly first: boolean;
  readonly onOpen: (member: SuperThreadMember) => void;
}) {
  const { shell, hint } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint ? `${shell.title}, ${hint}` : shell.title}
      onPress={() => props.onOpen({ environmentId: shell.environmentId, threadId: shell.id })}
      className={cn(
        "flex-row items-center gap-3 px-4 py-3",
        !props.first && "border-t border-border-subtle",
      )}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-base text-foreground" numberOfLines={1}>
          {shell.title}
        </Text>
        {hint ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {hint}
          </Text>
        ) : null}
      </View>
      <SuperThreadStatus thread={shell} />
    </Pressable>
  );
}
