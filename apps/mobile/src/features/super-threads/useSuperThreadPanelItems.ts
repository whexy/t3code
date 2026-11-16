import { CommonActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";

/** A super thread's transcript links back to its page, which the first send skips. */
export function useSuperThreadPanelItems(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "source"> | null,
): ReadonlyArray<AppBarMenuItem> {
  const navigation = useNavigation();
  if (thread === null || thread.source.superThread === undefined) return [];
  return [
    {
      id: "super-thread",
      title: "Super thread",
      icon: "point.3.connected.trianglepath.dotted",
      onPress: () =>
        // Returns to the page when the transcript was opened from it, instead of stacking another.
        navigation.dispatch(
          CommonActions.navigate({
            name: "SuperThread",
            params: { environmentId: thread.environmentId, threadId: thread.id },
            pop: true,
          }),
        ),
    },
  ];
}
