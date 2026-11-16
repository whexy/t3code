import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { STATUS_LABEL_BY_STATUS } from "../threads/thread-list-v2-items";
import { resolveThreadListV2Status } from "../threads/threadListV2";

const DONE = {
  label: "Done",
  icon: "checkmark.circle",
  className: "text-adaptive-emerald-700-300",
  iconTintClassName: "accent-adaptive-emerald-700-300",
} as const;

const SETTLED = {
  label: "Settled",
  icon: "checkmark",
  className: "text-foreground-muted",
  iconTintClassName: "accent-foreground-muted",
} as const;

/** The list row's status words and icons, without its timers, unread and wake tracking. */
export function SuperThreadStatus(props: {
  readonly thread: EnvironmentThreadShell;
  readonly className?: string;
}) {
  const { thread } = props;
  const status = resolveThreadListV2Status(thread);
  const presentation =
    thread.settledOverride === "settled"
      ? SETTLED
      : status === "ready"
        ? thread.latestRun === null
          ? null
          : DONE
        : STATUS_LABEL_BY_STATUS[status];
  if (!presentation) return null;
  const label = presentation.label ?? (status === "waiting" ? "Waiting" : "Working");
  return (
    <View className={cn("shrink-0 flex-row items-center gap-1", props.className)}>
      <SymbolView
        name={presentation.icon}
        size={11}
        tintColorClassName={presentation.iconTintClassName}
        type="monochrome"
      />
      <Text className={cn("text-xs font-t3-medium", presentation.className)}>{label}</Text>
    </View>
  );
}
