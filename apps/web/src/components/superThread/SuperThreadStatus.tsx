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
import { resolveSuperThreadRowStatus, type SuperThreadRowStatus } from "./superThread.logic";

// The sidebar row's status words, icons and colors, without its motion.
const STATUS_PRESENTATION: Record<
  NonNullable<SuperThreadRowStatus>,
  { readonly label: string; readonly icon: typeof CircleCheckIcon; readonly className: string }
> = {
  working: { label: "Working", icon: CircleDashedIcon, className: "text-info-foreground" },
  waiting: { label: "Waiting", icon: CircleDotDashedIcon, className: "text-muted-foreground" },
  approval: { label: "Approval", icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: {
    label: "Input",
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  request: { label: "Request", icon: UserRoundIcon, className: "text-guest-foreground" },
  failed: { label: "Failed", icon: CircleAlertIcon, className: "text-error-foreground" },
  done: { label: "Done", icon: CircleCheckIcon, className: "text-success-foreground" },
};

export function SuperThreadStatus(props: {
  readonly thread: EnvironmentThreadShell;
  readonly className?: string;
}) {
  const status = resolveSuperThreadRowStatus(props.thread);
  if (status === null) return null;
  const { label, icon: Icon, className } = STATUS_PRESENTATION[status];
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
