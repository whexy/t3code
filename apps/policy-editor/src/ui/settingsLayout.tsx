import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../shims/cn.ts";

// The markup of SettingsSection, SettingsGroup and SettingsRow in
// apps/web/src/components/settings/, which read environment and router state the editor lacks.

export function SettingsGroup({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-slot="settings-group"
      {...props}
      className={cn(
        "panel relative overflow-visible text-ink",
        "[&>*+*]:border-t [&>*+*]:border-black/5 [&>[data-slot=settings-row]]:rounded-none",
        className,
      )}
    />
  );
}

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
    <section {...props} className="scroll-mt-20 space-y-3">
      <div className="space-y-1 px-4 sm:px-6">
        <h2 className="flex min-h-7 items-center font-title text-lg font-bold tracking-tight text-ink">
          {title}
        </h2>
        {description ? (
          <p className="text-xs leading-normal text-ink-muted">{description}</p>
        ) : null}
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

export function SettingsGroupHeading({ children }: { readonly children: ReactNode }) {
  return (
    <div className="px-4 pt-4 pb-2 text-xs font-semibold tracking-wide text-ink-muted uppercase sm:px-6">
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
  ...props
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  readonly title: ReactNode;
  readonly badge?: ReactNode;
  readonly description?: ReactNode;
  readonly status?: ReactNode;
  readonly control?: ReactNode;
  readonly children?: ReactNode;
  readonly invalid?: boolean;
}) {
  return (
    <div
      {...props}
      data-slot="settings-row"
      className={cn(
        "group/settings-row @container/settings-row scroll-mt-20 px-4 py-4 sm:px-6",
        invalid && "bg-wash",
      )}
    >
      <div className="flex flex-col gap-3 @lg/settings-row:flex-row @lg/settings-row:items-center @lg/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 flex-wrap items-center gap-1.5">
            <h3 className="font-title text-sm font-bold text-ink">{title}</h3>
            {badge}
          </div>
          {description ? (
            <p className="text-balance text-xs leading-normal text-ink-muted">{description}</p>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-ink-muted">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-2 @lg/settings-row:w-auto @lg/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
