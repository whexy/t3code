import {
  ProviderDriverKind,
  type OrchestrationV2ProviderTurn,
  type ThreadModelUsage,
  type ThreadOtherUsage,
  type ThreadUsage,
  type UsagePricingStatus,
  type UsageTokenTotals,
} from "@t3tools/contracts";
import { EMPTY_TOTALS, totalTokens } from "@t3tools/provider-core/server/usage";
import { parseOpenCodeModelSlug } from "@t3tools/provider-opencode/server/OpenCodeRuntime";

import { priceUsage, type RateTable } from "./usagePricing.ts";

export interface ThreadUsagePricing {
  readonly rates: RateTable;
  readonly priceOverrides: RateTable;
  readonly modelAliases: ReadonlyMap<string, string>;
  readonly status: UsagePricingStatus;
}

type ProviderTurnUsage = Pick<OrchestrationV2ProviderTurn, "turnTokenUsage" | "nativeTurnRef">;
type TurnTokenUsage = NonNullable<OrchestrationV2ProviderTurn["turnTokenUsage"]>;

const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

/** Tokens split across several models cannot be priced per model, so they stay unattributed. */
function turnModel(
  usage: TurnTokenUsage,
  driver: ProviderDriverKind | undefined,
  aliases: ReadonlyMap<string, string>,
): string | null {
  const models = usage.models ?? [];
  const reported = models.length === 1 ? models[0]!.trim() : "";
  if (reported.length === 0) return null;
  // OpenCode turns record `providerID/modelID`; the Usage page prices OpenCode's own `modelID`.
  const model =
    driver === OPENCODE_DRIVER ? (parseOpenCodeModelSlug(reported)?.modelID ?? reported) : reported;
  return aliases.get(model) ?? model;
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

/** Other usage plus the cache tokens inside its input, which pricing needs and the row omits. */
interface OtherUsage extends ThreadOtherUsage {
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
}

// Without a cache split that fits inside the input, the input is priced as uncached.
function turnOther(reported: NonNullable<TurnTokenUsage["otherUsage"]>): OtherUsage {
  const cachedInputTokens = reported.cachedInputTokens ?? 0;
  const cacheCreationTokens = reported.cacheCreationTokens ?? 0;
  const fits = cachedInputTokens + cacheCreationTokens <= reported.inputTokens;
  return {
    inputTokens: reported.inputTokens,
    outputTokens: reported.outputTokens,
    cachedInputTokens: fits ? cachedInputTokens : 0,
    cacheCreationTokens: fits ? cacheCreationTokens : 0,
  };
}

function addOther(a: OtherUsage | null, b: OtherUsage): OtherUsage {
  return a === null
    ? b
    : {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
        cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
      };
}

function otherTokens(other: ThreadOtherUsage | null): number {
  return other === null ? 0 : other.inputTokens + other.outputTokens;
}

function rowTokens(row: Pick<ThreadModelUsage, "totals" | "otherUsage">): number {
  return totalTokens(row.totals) + otherTokens(row.otherUsage);
}

/** Prices other usage at the same model's rates; pricing is linear. */
function priceRow(
  pricing: ThreadUsagePricing,
  model: string | null,
  totals: UsageTokenTotals,
  other: OtherUsage | null,
) {
  if (model === null) return { costUsd: 0, priced: false };
  const priced = priceUsage(
    pricing.rates,
    {
      model,
      totals: {
        ...totals,
        uncachedInputTokens:
          totals.uncachedInputTokens +
          (other === null
            ? 0
            : other.inputTokens - other.cachedInputTokens - other.cacheCreationTokens),
        cachedInputTokens: totals.cachedInputTokens + (other?.cachedInputTokens ?? 0),
        cacheCreationTokens: totals.cacheCreationTokens + (other?.cacheCreationTokens ?? 0),
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
  turns: ReadonlyArray<ProviderTurnUsage>,
  pricing: ThreadUsagePricing,
): ThreadUsage | null {
  const byModel = new Map<
    string | null,
    { totals: UsageTokenTotals; otherUsage: OtherUsage | null; turns: number }
  >();
  let incompleteTurns = 0;

  for (const turn of turns) {
    const usage = turn.turnTokenUsage;
    if (usage === undefined) continue;
    if (usage.usageStatus !== "complete") incompleteTurns += 1;
    const totals = turnTotals(usage);
    const other =
      usage.otherUsage !== undefined &&
      usage.otherUsage.inputTokens + usage.otherUsage.outputTokens > 0
        ? turnOther(usage.otherUsage)
        : null;
    if (totalTokens(totals) + otherTokens(other) === 0) continue;
    const model = turnModel(usage, turn.nativeTurnRef?.driver, pricing.modelAliases);
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
    otherUsage:
      entry.otherUsage === null
        ? null
        : {
            inputTokens: entry.otherUsage.inputTokens,
            outputTokens: entry.otherUsage.outputTokens,
          },
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
