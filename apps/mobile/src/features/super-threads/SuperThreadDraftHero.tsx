import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** Replaces the new-task hero for a draft that becomes a super thread when sent. */
export function SuperThreadDraftHero(props: { readonly environmentControl: ReactNode }) {
  return (
    <View className="items-center gap-2 px-6" testID="new-task-hero">
      <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
        New super thread
      </Text>
      <Text className="text-center text-sm leading-normal text-foreground-muted">
        Describe the goal. Its agent launches threads across your projects and tracks them on a
        board.
      </Text>
      {props.environmentControl}
    </View>
  );
}
