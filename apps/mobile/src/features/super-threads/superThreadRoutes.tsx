import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { createNativeStackScreen } from "@react-navigation/native-stack";
import { useEffect } from "react";

import { pageRoute } from "../layout/route-options";

type SuperThreadRouteParams = { readonly environmentId: string; readonly threadId: string };

/** The super page became a panel of the conversation; its old links land on the conversation. */
function SuperThreadRedirect({ route }: StaticScreenProps<SuperThreadRouteParams>) {
  const navigation = useNavigation();
  const { environmentId, threadId } = route.params;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a linked route replaces itself once mounted; navigating during render is not allowed
  useEffect(() => {
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
  }, [navigation, environmentId, threadId]);
  return null;
}

/** Spread into the root stack's screens. */
export const SUPER_THREAD_SCREENS = {
  SuperThread: createNativeStackScreen({
    screen: SuperThreadRedirect,
    linking: "super/:environmentId/:threadId",
    options: pageRoute({ duoMinimize: "never" }),
  }),
};
