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
        "relative overflow-visible rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5",
        "[&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none",
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
    <section {...props} className="scroll-mt-20 space-y-2.5">
      <div className="space-y-1 px-3 sm:px-4">
        <h2 className="flex min-h-7 items-center text-base font-semibold text-foreground">
          {title}
        </h2>
        {description ? (
          <p className="max-w-2xl text-xs leading-normal text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

export function SettingsGroupHeading({ children }: { readonly children: ReactNode }) {
  return (
    <div className="bg-muted/24 px-3 py-1.5 text-xs font-medium text-muted-foreground sm:px-4">
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
        "group/settings-row @container/settings-row scroll-mt-20 rounded-xl px-3 sm:px-4",
        children ? "pt-3 pb-3" : "py-3",
        invalid && "bg-destructive/4",
      )}
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            {badge}
          </div>
          {description ? (
            <p className="max-w-2xl text-balance text-xs leading-normal text-muted-foreground">
              {description}
            </p>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
