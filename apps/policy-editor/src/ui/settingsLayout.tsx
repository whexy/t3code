import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../shims/cn.ts";

// The roles of SettingsSection, SettingsGroup and SettingsRow in apps/web/src/components/settings/,
// which read environment and router state the editor lacks, drawn as Frost panels.

export function SettingsSection({
  title,
  description,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<"section">, "title"> & {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section {...props} className="panel scroll-mt-10 pb-4 text-ink">
      <div className="space-y-1 px-4 pt-6 pb-2 sm:px-8 sm:pt-8">
        <h2 className="font-title text-lg font-semibold tracking-tight">{title}</h2>
        {description ? <p className="font-article text-sm text-ink-muted">{description}</p> : null}
      </div>
      <div className="settings-rows px-4 sm:px-8">{children}</div>
    </section>
  );
}

export function SettingsGroupHeading({ children }: { readonly children: ReactNode }) {
  return (
    <div className="pt-4 pb-1 font-title text-base font-semibold text-ink first:pt-2">
      {children}
    </div>
  );
}

export function SettingsRow({
  title,
  badge,
  description,
  status,
  control,
  children,
  invalid = false,
  stacked = false,
  ...props
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  readonly title: ReactNode;
  readonly badge?: ReactNode;
  readonly description?: ReactNode;
  readonly status?: ReactNode;
  readonly control?: ReactNode;
  readonly children?: ReactNode;
  readonly invalid?: boolean;
  /** The value sits below the row at full width, so the text need not leave room for it. */
  readonly stacked?: boolean;
}) {
  const heading = (
    <div className="flex min-h-5 flex-wrap items-center gap-1.5">
      <h3 className="font-title text-sm font-semibold text-ink">{title}</h3>
      {badge}
    </div>
  );
  const text = (
    <>
      {description ? (
        <p className="font-article text-sm leading-snug text-ink-muted">{description}</p>
      ) : null}
      {status ? <div className="pt-0.5 text-xs text-ink-muted">{status}</div> : null}
    </>
  );
  const controls = control ? (
    <div className="flex w-full min-w-0 shrink-0 flex-col items-stretch gap-2 @lg/settings-row:w-60">
      {control}
    </div>
  ) : null;
  return (
    <div
      {...props}
      data-slot="settings-row"
      className={cn(
        "group/settings-row @container/settings-row scroll-mt-10 py-4",
        invalid && "-mx-3 rounded-xl bg-wash px-3",
      )}
    >
      {stacked ? (
        <div className="space-y-1">
          <div className="flex flex-col gap-3 @lg/settings-row:flex-row @lg/settings-row:items-center @lg/settings-row:justify-between @lg/settings-row:gap-8">
            {heading}
            {controls}
          </div>
          {text}
        </div>
      ) : (
        <div className="flex flex-col gap-3 @lg/settings-row:flex-row @lg/settings-row:items-start @lg/settings-row:gap-8">
          <div className="min-w-0 flex-1 space-y-1">
            {heading}
            {text}
          </div>
          {controls}
        </div>
      )}
      {children}
    </div>
  );
}
