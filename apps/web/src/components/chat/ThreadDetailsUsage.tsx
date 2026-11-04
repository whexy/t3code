import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  ThreadId,
  ThreadModelUsage,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { formatModelSlugName } from "@t3tools/shared/model";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import {
  collectProviderUsageLimits,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { Fragment, type ReactNode, useEffect, useRef } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { getDisplayModelName } from "./providerIconUtils";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { type ThreadUsageLine, type ThreadUsageView, threadUsageView } from "./threadUsageLines";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
  /** Changes when one of the thread's turns finishes, so the session usage refetches. */
  readonly usageRevision: string;
}

type UsageTone = "error" | "warning" | null;

/** The selected provider's limit windows. Each row reads as room left. */
export function ThreadDetailsUsage({
  providerInstanceId,
  providers,
  sources,
}: Pick<ThreadDetailsUsageInput, "providerInstanceId" | "providers" | "sources">) {
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const report =
    providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, now)
      : null;
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const limits =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits;
  if (!limits) return null;
  const notice = limitsNotice(limits);

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage limits"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {notice ? (
          <UsageRow
            label="Limits"
            fill={null}
            tone={null}
            value="Unavailable"
            tooltip={<span className="text-foreground">{notice}</span>}
          />
        ) : (
          limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)
        )}
      </div>
    </ThreadDetailsSection>
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title="Context window"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label="Context"
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
          }
          ariaValue={used !== null ? `${used}% used` : `${usedTokens} tokens used`}
          tooltip={
            <>
              <span className="text-foreground">
                {used !== null ? `Context: ${used}% used` : `Context: ${usedTokens} tokens used`}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {usage.usedTokens.toLocaleString("en-US")} of {maxTokens.toLocaleString("en-US")}{" "}
                  tokens
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(null, threshold)}
                </span>
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

/** What this thread spent, per model when it ran on several. Hidden until the server reports some. */
export function ThreadDetailsSessionUsage({
  environmentId,
  threadId,
  revision,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly revision: string;
  readonly providers: readonly ServerProvider[];
}) {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .threadUsage === true;
  const query = useEnvironmentQuery(
    supported ? serverEnvironment.threadUsage({ environmentId, input: { threadId } }) : null,
  );
  const { refresh } = query;
  const refreshedRevision = useRef(revision);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches server-priced usage once per finished turn
  useEffect(() => {
    if (!supported || refreshedRevision.current === revision) return;
    refreshedRevision.current = revision;
    refresh();
  }, [refresh, revision, supported]);

  const view = threadUsageView({ supported, usage: query.data });
  if (view === null) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-session-usage-heading"
      title="Session usage"
      showHeading={false}
    >
      <div
        className={cn(
          "grid gap-x-3 text-xs",
          view.pricing === "unavailable"
            ? "grid-cols-[minmax(0,1fr)_auto]"
            : "grid-cols-[minmax(0,1fr)_auto_auto]",
        )}
      >
        {view.lines.map((line) => (
          <SessionUsageRow
            key={line.key}
            line={line}
            view={view}
            label={
              line.kind === "total"
                ? "Total"
                : line.model === null
                  ? "Unknown model"
                  : modelDisplayName(line.model, providers)
            }
          />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

function modelDisplayName(model: string, providers: readonly ServerProvider[]): string {
  for (const provider of providers) {
    const option = provider.models.find(
      (candidate) => candidate.slug === model || candidate.aliases?.includes(model) === true,
    );
    if (option) return getDisplayModelName(option);
  }
  // Routed ids such as `cliproxyapi/deepseek-v4.1-flash` carry a gateway prefix the name does not need.
  return formatModelSlugName(model.slice(model.lastIndexOf("/") + 1));
}

/** The line that answers "what did this thread cost": the only line, or the total. */
function isHeadline(line: ThreadUsageLine, view: ThreadUsageView): boolean {
  return line.kind === "total" || view.lines.length === 1;
}

function formatCost(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.005 ? "<$0.01" : formatUsd(costUsd);
}

/** A figure plus whether it is only a floor, shown as a trailing + outside the column. */
interface Figure {
  readonly text: string;
  readonly floor: boolean;
}

/** Null when prices are unavailable and the cost column is dropped. */
function costFigure(line: ThreadUsageLine, view: ThreadUsageView): Figure | null {
  if (view.pricing === "unavailable") return null;
  if (!line.priced && line.costUsd === 0) return { text: "Unpriced", floor: false };
  const text = formatCost(line.costUsd);
  // "<$0.01" already says the amount is inexact.
  const floor =
    !text.startsWith("<") && (!line.priced || (isHeadline(line, view) && view.incompleteTurns > 0));
  return { text, floor };
}

function tokensFigure(line: ThreadUsageLine, view: ThreadUsageView): Figure {
  return {
    text: formatTokens(line.tokens),
    floor: isHeadline(line, view) && view.incompleteTurns > 0,
  };
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** Exact counts per category, zero categories omitted. Reasoning is part of output. */
function usageBreakdown(
  usage: ThreadModelUsage,
): readonly { readonly label: string; readonly count: number; readonly nested?: true }[] {
  const { totals, otherUsage } = usage;
  return [
    { label: "Uncached input", count: totals.uncachedInputTokens },
    { label: "Cache read", count: totals.cachedInputTokens },
    { label: "Cache write", count: totals.cacheCreationTokens },
    { label: "Output", count: totals.outputTokens },
    { label: "Reasoning", count: totals.reasoningTokens, nested: true as const },
    {
      label: "Subagents and compaction",
      count: otherUsage === null ? 0 : otherUsage.inputTokens + otherUsage.outputTokens,
    },
  ].filter((row) => row.count > 0);
}

function usageNotes(line: ThreadUsageLine, view: ThreadUsageView): readonly string[] {
  const notes: string[] = [];
  if (line.usage?.otherUsage != null && line.priced && view.pricing !== "unavailable")
    notes.push("Subagent and compaction cost is estimated");
  if (view.pricing === "unavailable") notes.push("Model prices are unavailable");
  else if (!line.priced)
    notes.push(
      line.kind === "model"
        ? "No price for this model"
        : line.costUsd > 0
          ? "Cost includes priced models only"
          : "No model has a price",
    );
  if (isHeadline(line, view) && view.incompleteTurns > 0)
    notes.push(`${plural(view.incompleteTurns, "turn")} reported partial usage`);
  return notes;
}

/** The + hangs outside the right edge so digits stay aligned with lines that have none. */
function FigureText({ figure }: { readonly figure: Figure }) {
  return (
    <span className="relative">
      {figure.text}
      {figure.floor ? <span className="absolute left-full">+</span> : null}
    </span>
  );
}

function SessionUsageRow({
  line,
  view,
  label,
}: {
  readonly line: ThreadUsageLine;
  readonly view: ThreadUsageView;
  readonly label: string;
}) {
  const headline = isHeadline(line, view);
  const cost = costFigure(line, view);
  const tokens = tokensFigure(line, view);
  const priced = cost !== null && cost.text !== "Unpriced";
  const tokensLabel = `${formatCount(line.tokens)}${tokens.floor ? "+" : ""} tokens`;
  const costLabel =
    cost === null ? "prices unavailable" : `${cost.text}${cost.floor ? " or more" : ""}`;
  const breakdown = line.usage ? usageBreakdown(line.usage) : [];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`${label}: ${tokensLabel}, ${costLabel}`}
            className="col-span-full grid h-6 cursor-default grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        <span
          className={cn(
            "min-w-0 truncate",
            line.kind === "total" ? "font-medium text-foreground/80" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <span
          className={cn(
            "text-end tabular-nums whitespace-nowrap",
            headline && !priced ? "font-medium text-foreground/80" : "text-muted-foreground",
          )}
        >
          <FigureText figure={tokens} />
        </span>
        {cost === null ? null : (
          <span
            className={cn(
              "text-end tabular-nums whitespace-nowrap",
              headline && priced ? "font-medium text-foreground/80" : "text-muted-foreground",
            )}
          >
            <FigureText figure={cost} />
          </span>
        )}
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {plural(line.tokens, "token")}
            {priced ? ` · ${cost.text}${cost.floor ? "+" : ""} at API prices` : ""}
          </span>
          {breakdown.length > 0 ? (
            <div className="grid grid-cols-[auto_auto] gap-x-4">
              {breakdown.map((row) => (
                <Fragment key={row.label}>
                  <span className={cn("text-muted-foreground", row.nested && "ps-2")}>
                    {row.label}
                  </span>
                  <span className="text-end tabular-nums text-foreground/80">
                    {formatCount(row.count)}
                  </span>
                </Fragment>
              ))}
            </div>
          ) : null}
          {line.usage ? (
            <span className="text-muted-foreground">{plural(line.usage.turns, "turn")}</span>
          ) : null}
          {usageNotes(line, view).map((text) => (
            <span key={text} className="text-muted-foreground">
              {text}
            </span>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      value={`${left}%`}
      ariaValue={`${left}% left`}
      tooltip={
        <>
          <span className="text-foreground">
            {window.label}: {left}% left
          </span>
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              Resets in {formatDuration(resetsAt - now)} ·{" "}
              {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            </span>
          ) : null}
          {pace ? <span className="text-muted-foreground">{PACE_LABEL[pace]}</span> : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`${label}: ${ariaValue}`}
            className="col-span-3 grid h-6 cursor-default grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground">{label}</span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/60"
                style={{ left: `${tick}%` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
