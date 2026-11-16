import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  shouldRecedeSidebarThread,
} from "../Sidebar.logic";
import { resolveSuperThreadRowStatus, type SuperThreadRowStatus } from "./superThread.logic";

// The sidebar row's status words, icons and colors, without its motion.
const STATUS_PRESENTATION: Record<
  NonNullable<SuperThreadRowStatus>,
  { readonly label: string; readonly icon: typeof CircleCheckIcon; readonly className: string }
> = {
  "setting-up": { label: "Setting up", icon: CircleDashedIcon, className: "text-info-foreground" },
  goal: { label: "Goal", icon: CircleDashedIcon, className: "text-info-foreground" },
  working: { label: "Working", icon: CircleDashedIcon, className: "text-info-foreground" },
  waiting: { label: "Waiting", icon: CircleDotDashedIcon, className: "text-muted-foreground" },
  approval: { label: "Approval", icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: {
    label: "Input",
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  request: { label: "Request", icon: UserRoundIcon, className: "text-guest-foreground" },
  limited: { label: "Limited", icon: CircleAlertIcon, className: "text-warning-foreground" },
  failed: { label: "Failed", icon: CircleAlertIcon, className: "text-error-foreground" },
  done: { label: "Done", icon: CircleCheckIcon, className: "text-success-foreground" },
};

/** What a super thread row shows, read the way the sidebar's own rows read it. */
export function useSuperThreadRowState(thread: EnvironmentThreadShell, isActive: boolean) {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[key]);
  const isUnread = hasUnseenCompletion({
    ...thread,
    lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
  });
  const sidebarStatus = resolveSidebarThreadStatus(thread);
  return {
    status: resolveSuperThreadRowStatus(thread, isUnread),
    recede: shouldRecedeSidebarThread({
      status: sidebarStatus,
      isUnread,
      isWoke: false,
      isActive,
      isSelected: false,
    }),
    readFailure: sidebarStatus === "failed" && !isUnread,
  };
}

export function SuperThreadStatusLabel(props: {
  readonly status: SuperThreadRowStatus;
  readonly className?: string;
}) {
  if (props.status === null) return null;
  const { label, icon: Icon, className } = STATUS_PRESENTATION[props.status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
        className,
        props.className,
      )}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      {label}
    </span>
  );
}

export function SuperThreadStatus(props: { readonly thread: EnvironmentThreadShell }) {
  const { status } = useSuperThreadRowState(props.thread, false);
  return <SuperThreadStatusLabel status={status} />;
}
