import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  SUPER_THREAD_MAP_STATE_LABELS,
  resolveSuperThreadMapNodeState,
} from "@t3tools/client-runtime/state/super-thread-map";
import type { SuperThreadMapNode, SuperThreadMember } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListSection } from "../../components/ui/ListSection";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { STATE_PRESENTATION, useLinkedShells } from "./SuperThreadMap";
import { SuperThreadStatus } from "./SuperThreadStatus";

/** What web's hover card shows: purpose, the agent's note and the node's threads. */
export function SuperThreadNodeDetail(props: {
  readonly node: SuperThreadMapNode;
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
