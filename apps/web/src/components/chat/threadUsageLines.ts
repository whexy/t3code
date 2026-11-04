import type { ThreadModelUsage, ThreadUsage } from "@t3tools/contracts";

export interface ThreadUsageLine {
  readonly key: string;
  readonly kind: "model" | "total";
  /** The model's id for a model line; null for the total line or an unreported model. */
  readonly model: string | null;
  readonly tokens: number;
  readonly costUsd: number;
  /** False when some of this line's tokens have no price, so its cost understates spend. */
  readonly priced: boolean;
  /** The model's breakdown; for a single-model thread the one line carries it too. */
  readonly usage: ThreadModelUsage | null;
}

export interface ThreadUsageView {
  readonly lines: readonly ThreadUsageLine[];
  readonly incompleteTurns: number;
  readonly pricing: ThreadUsage["pricing"];
}

function modelTokens(usage: ThreadModelUsage): number {
  const { totals, otherUsage } = usage;
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens +
    (otherUsage === null ? 0 : otherUsage.inputTokens + otherUsage.outputTokens)
  );
}

function modelLine(usage: ThreadModelUsage): ThreadUsageLine {
  return {
    key: `model:${usage.model ?? ""}`,
    kind: "model",
    model: usage.model,
    tokens: modelTokens(usage),
    costUsd: usage.costUsd,
    priced: usage.priced,
    usage,
  };
}

/**
 * Null hides the row: an older server without `threadUsage`, no answer yet, or a thread whose
 * provider reported nothing. One model shows as one line; several add a total line.
 */
export function threadUsageView(input: {
  readonly supported: boolean;
  readonly usage: ThreadUsage | null;
}): ThreadUsageView | null {
  const { usage } = input;
  if (!input.supported || usage === null || usage.models.length === 0) return null;
  const models = usage.models.map(modelLine);
  const lines =
    models.length === 1
      ? models
      : [
          ...models,
          {
            key: "total",
            kind: "total" as const,
            model: null,
            tokens: usage.totalTokens,
            costUsd: usage.costUsd,
            priced: usage.models.every((model) => model.priced),
            usage: null,
          },
        ];
  return { lines, incompleteTurns: usage.incompleteTurns, pricing: usage.pricing };
}
