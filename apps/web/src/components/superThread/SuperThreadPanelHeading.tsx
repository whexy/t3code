import type { LucideIcon } from "lucide-react";

import { Separator } from "../ui/separator";

/** A group label in the super thread panel, the same as the pull request panel's groups. */
export function SuperThreadPanelHeading(props: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly count?: number;
}) {
  const Icon = props.icon;
  return (
    <div className="flex items-center gap-2 px-2.5 pb-1 text-xs font-medium text-muted-foreground/70">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <h2 className="shrink-0">{props.title}</h2>
      {props.count === undefined ? null : (
        <span className="shrink-0 tabular-nums text-muted-foreground/50">{props.count}</span>
      )}
      <Separator className="min-w-2 flex-1" />
    </div>
  );
}

/** A panel row's surface, matching the pull request panel's rows. */
export const SUPER_THREAD_PANEL_ROW_CLASS =
  "flex w-full flex-col justify-center rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
