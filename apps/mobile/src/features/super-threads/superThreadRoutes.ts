import { createNativeStackScreen } from "@react-navigation/native-stack";

import { pageRoute } from "../layout/route-options";
import { SuperThreadRouteScreen } from "./SuperThreadRouteScreen";

/** Spread into the root stack's screens; a list's super thread header selects this page. */
export const SUPER_THREAD_SCREENS = {
  SuperThread: createNativeStackScreen({
    screen: SuperThreadRouteScreen,
    linking: "super/:environmentId/:threadId",
    options: pageRoute({ duoMinimize: "never" }),
  }),
};
