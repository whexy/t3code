import type {
  OrchestrationV2ProviderTurn,
  ThreadModelUsage,
  ThreadOtherUsage,
  ThreadUsage,
  UsagePricingStatus,
  UsageTokenTotals,
} from "@t3tools/contracts";
import { EMPTY_TOTALS, totalTokens } from "@t3tools/provider-core/server/usage";

import { priceUsage, type RateTable } from "./usagePricing.ts";

export interface ThreadUsagePricing {
  readonly rates: RateTable;
  readonly priceOverrides: RateTable;
  readonly modelAliases: ReadonlyMap<string, string>;
  readonly status: UsagePricingStatus;
}

type TurnTokenUsage = NonNullable<OrchestrationV2ProviderTurn["turnTokenUsage"]>;

/** Tokens split across several models cannot be priced per model, so they stay unattributed. */
function turnModel(usage: TurnTokenUsage, aliases: ReadonlyMap<string, string>): string | null {
  const models = usage.models ?? [];
  const model = models.length === 1 ? models[0]!.trim() : "";
  return model.length === 0 ? null : (aliases.get(model) ?? model);
}

// Provider input counts include cache reads and writes; pricing needs them apart.
function turnTotals(usage: TurnTokenUsage): UsageTokenTotals {
  // A local command's counters describe the command's result, not model work.
  if (usage.localCommand === true) return EMPTY_TOTALS;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    uncachedInputTokens: Math.max(
      0,
      (usage.inputTokens ?? 0) - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(usage.reasoningTokens ?? 0, outputTokens),
  };
}

function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

function addOther(a: ThreadOtherUsage | null, b: ThreadOtherUsage): ThreadOtherUsage {
  return a === null
    ? b
    : { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

function otherTokens(other: ThreadOtherUsage | null): number {
  return other === null ? 0 : other.inputTokens + other.outputTokens;
}

function rowTokens(row: Pick<ThreadModelUsage, "totals" | "otherUsage">): number {
  return totalTokens(row.totals) + otherTokens(row.otherUsage);
}

/** Prices other usage as uncached input and output of the same model; pricing is linear. */
function priceRow(
  pricing: ThreadUsagePricing,
  model: string | null,
  totals: UsageTokenTotals,
  other: ThreadOtherUsage | null,
) {
  if (model === null) return { costUsd: 0, priced: false };
  const priced = priceUsage(
    pricing.rates,
    {
      model,
      totals: {
        ...totals,
        uncachedInputTokens: totals.uncachedInputTokens + (other?.inputTokens ?? 0),
        outputTokens: totals.outputTokens + (other?.outputTokens ?? 0),
      },
      speed: "standard",
      reportedCostUsd: null,
    },
    pricing.priceOverrides,
  );
  return { costUsd: priced.costUsd, priced: priced.costSource !== "unpriced" };
}

/**
 * Sums a thread's provider turns per model. Claude reports subagent and compaction work only in
 * the root turn's `otherUsage`; Codex reports each native thread's turns separately and leaves
 * `otherUsage` empty, so adding both never counts a token twice. Null when nothing was reported.
 */
export function summarizeThreadUsage(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "turnTokenUsage">>,
  pricing: ThreadUsagePricing,
): ThreadUsage | null {
  const byModel = new Map<
    string | null,
    { totals: UsageTokenTotals; otherUsage: ThreadOtherUsage | null; turns: number }
  >();
  let incompleteTurns = 0;

  for (const { turnTokenUsage: usage } of turns) {
    if (usage === undefined) continue;
    if (usage.usageStatus !== "complete") incompleteTurns += 1;
    const totals = turnTotals(usage);
    const reported = usage.otherUsage;
    const other =
      reported !== undefined && reported.inputTokens + reported.outputTokens > 0
        ? { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens }
        : null;
    if (totalTokens(totals) + otherTokens(other) === 0) continue;
    const model = turnModel(usage, pricing.modelAliases);
    const entry = byModel.get(model);
    byModel.set(model, {
      totals: entry === undefined ? totals : addTotals(entry.totals, totals),
      otherUsage:
        other === null ? (entry?.otherUsage ?? null) : addOther(entry?.otherUsage ?? null, other),
      turns: (entry?.turns ?? 0) + 1,
    });
  }

  if (byModel.size === 0) return null;

  const models: ThreadModelUsage[] = [...byModel].map(([model, entry]) => ({
    model,
    totals: entry.totals,
    otherUsage: entry.otherUsage,
    ...priceRow(pricing, model, entry.totals, entry.otherUsage),
    turns: entry.turns,
  }));
  // Code-unit order, so servers in different locales return the same order.
  models.sort(
    (a, b) =>
      Number(a.model === null) - Number(b.model === null) ||
      b.costUsd - a.costUsd ||
      rowTokens(b) - rowTokens(a) ||
      ((a.model ?? "") < (b.model ?? "") ? -1 : (a.model ?? "") > (b.model ?? "") ? 1 : 0),
  );
  return {
    models,
    totalTokens: models.reduce((sum, row) => sum + rowTokens(row), 0),
    costUsd: models.reduce((sum, row) => sum + row.costUsd, 0),
    incompleteTurns,
    pricing: pricing.status,
  };
}
