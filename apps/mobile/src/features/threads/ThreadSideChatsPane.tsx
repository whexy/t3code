import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { PaneListItem } from "../../components/ui/PaneListItem";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetPane } from "../../components/ui/SheetPane";
import { cn } from "../../lib/cn";
import { useSideChats } from "../../state/entities";
import { resolveThreadListV2Status } from "./threadListV2";
import { STATUS_LABEL_BY_STATUS } from "./thread-list-v2-items";

/** The thread's side chats, newest first, and where new ones start. */
export function ThreadSideChatsPane(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Null when a new side chat can start here. */
  readonly newSideChatUnavailableReason: string | null;
  readonly onNewSideChat: () => void;
  readonly onOpenSideChat: (threadId: ThreadId) => void;
}) {
  const sideChats = useSideChats({ environmentId: props.environmentId, threadId: props.threadId });
  const ordered = [...sideChats].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const canStart = props.newSideChatUnavailableReason === null;
  const isEmpty = ordered.length === 0;
  return (
    <SheetPane>
      <AppBar
        title="Side chats"
        actions={
          isEmpty
            ? []
            : [
                {
                  accessibilityLabel: "New side chat",
                  icon: "plus",
                  disabled: !canStart,
                  onPress: props.onNewSideChat,
                },
              ]
        }
      />
      <ScreenContent>
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName={isEmpty ? "pt-8 pb-6" : "px-3 pb-6"}
        >
          {isEmpty ? (
            <EmptyState
              variant="plain"
              title="No side chats yet"
              detail={
                props.newSideChatUnavailableReason ??
                "Ask a side question while this thread keeps working."
              }
              {...(canStart ? { actionLabel: "New side chat", onAction: props.onNewSideChat } : {})}
            />
          ) : (
            <>
              {canStart ? null : (
                <Text className="px-3 pt-3 text-xs text-foreground-muted">
                  {props.newSideChatUnavailableReason}
                </Text>
              )}
              {ordered.map((sideChat) => {
                const status = STATUS_LABEL_BY_STATUS[resolveThreadListV2Status(sideChat)];
                return (
                  <PaneListItem
                    key={sideChat.id}
                    selected={false}
                    onPress={() => props.onOpenSideChat(sideChat.id)}
                  >
                    <View className="flex-row items-center gap-3">
                      <SymbolView
                        name={status?.icon ?? "bubble.left.and.bubble.right"}
                        size={16}
                        tintColorClassName={status?.iconTintClassName ?? "accent-foreground-muted"}
                        type="monochrome"
                      />
                      <View className="min-w-0 flex-1">
                        <Text textRole="body" className="text-foreground" numberOfLines={2}>
                          {sideChat.title}
                        </Text>
                        <Text
                          className={cn(
                            "mt-0.5 text-xs",
                            status?.className ?? "text-foreground-muted",
                          )}
                        >
                          {status?.label ?? <RelativeTime timestamp={sideChat.updatedAt} />}
                        </Text>
                      </View>
                    </View>
                  </PaneListItem>
                );
              })}
            </>
          )}
        </ScrollView>
      </ScreenContent>
    </SheetPane>
  );
}
