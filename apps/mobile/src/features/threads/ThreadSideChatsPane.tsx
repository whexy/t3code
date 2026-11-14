import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
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
  return (
    <SheetPane>
      <AppBar
        title="Side chats"
        actions={[
          {
            accessibilityLabel: "New side chat",
            icon: "plus",
            disabled: !canStart,
            onPress: props.onNewSideChat,
          },
        ]}
      />
      <ScreenContent>
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pb-6"
        >
          {canStart ? null : (
            <Text className="pt-3 text-xs text-foreground-muted">
              {props.newSideChatUnavailableReason}
            </Text>
          )}
          {ordered.length === 0 ? (
            <View className="items-center gap-4 px-4 pt-10">
              <Text className="text-center text-sm text-foreground-muted">
                Ask about this thread without adding to it. A side chat starts from the thread's
                latest reply and works in the same folder.
              </Text>
              {canStart ? (
                <Button
                  label="New side chat"
                  icon="plus"
                  size="compact"
                  onPress={props.onNewSideChat}
                />
              ) : null}
            </View>
          ) : (
            ordered.map((sideChat) => {
              const status = STATUS_LABEL_BY_STATUS[resolveThreadListV2Status(sideChat)];
              return (
                <Pressable
                  key={sideChat.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Open side chat ${sideChat.title}${status?.label ? `, ${status.label}` : ""}`}
                  className="flex-row items-center gap-3 border-b border-border py-3 active:opacity-70"
                  onPress={() => props.onOpenSideChat(sideChat.id)}
                >
                  <SymbolView
                    name={status?.icon ?? "bubble.left.and.bubble.right"}
                    size={14}
                    tintColorClassName={status?.iconTintClassName ?? "accent-foreground-muted"}
                    type="monochrome"
                  />
                  <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                    {sideChat.title}
                  </Text>
                  <Text
                    className={cn("shrink-0 text-xs", status?.className ?? "text-foreground-muted")}
                  >
                    {status?.label ?? <RelativeTime timestamp={sideChat.updatedAt} />}
                  </Text>
                </Pressable>
              );
            })
          )}
        </ScrollView>
      </ScreenContent>
    </SheetPane>
  );
}
