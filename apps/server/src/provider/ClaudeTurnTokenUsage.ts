import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeTurnState, TurnTokenUsage } from "@t3tools/contracts";

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

const BILLED_USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;

function addKnownCount(finalCount: unknown, earlierCounts: ReadonlyArray<unknown>): unknown {
  const counts = [finalCount, ...earlierCounts]
    .map(finiteNonNegativeInteger)
    .filter((count) => count !== undefined);
  return counts.length === 0 ? finalCount : counts.reduce((sum, count) => sum + count, 0);
}

// Steering aborts the current segment; each SDK result reports only that segment's usage.
function withEarlierSegmentUsage(
  usage: Record<string, unknown>,
  earlierSegmentUsage: ReadonlyArray<unknown>,
): Record<string, unknown> {
  if (earlierSegmentUsage.length === 0) return usage;
  const segments = earlierSegmentUsage.map((segment) => (segment ?? {}) as Record<string, unknown>);
  const total = { ...usage };
  for (const field of BILLED_USAGE_FIELDS) {
    total[field] = addKnownCount(
      usage[field],
      segments.map((segment) => segment[field]),
    );
  }
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  total.output_tokens_details = {
    ...outputDetails,
    thinking_tokens: addKnownCount(
      outputDetails?.thinking_tokens,
      segments.map(
        (segment) =>
          (segment.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens,
      ),
    ),
  };
  return total;
}

/**
 * Token counts from the SDK's `modelUsage`; input includes cache reads and writes. Absent cache
 * counts are zero, which keeps the adapter's `{ inputTokens: 0, outputTokens: 0 }` seed valid.
 */
export interface ClaudeLedgerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationTokens?: number;
}

const EMPTY_CLAUDE_LEDGER_USAGE: Required<ClaudeLedgerUsage> = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
};

const LEDGER_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
] as const;

/** Per-model totals from the SDK's `modelUsage`, which grows for the life of one CLI process. */
export type ClaudeModelLedger = ReadonlyMap<string, ClaudeLedgerUsage>;

/** Unknown when absent or empty: a process that did model work never reports an empty ledger. */
export function claudeModelLedger(modelUsage: unknown): ClaudeModelLedger | undefined {
  if (typeof modelUsage !== "object" || modelUsage === null) return undefined;
  if (Object.keys(modelUsage).length === 0) return undefined;
  const ledger = new Map<string, ClaudeLedgerUsage>();
  for (const [model, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
    const fields = (entry ?? {}) as Record<string, unknown>;
    const input = finiteNonNegativeInteger(fields.inputTokens);
    const output = finiteNonNegativeInteger(fields.outputTokens);
    if (input === undefined || output === undefined) return undefined;
    const cacheRead = finiteNonNegativeInteger(fields.cacheReadInputTokens) ?? 0;
    const cacheWrite = finiteNonNegativeInteger(fields.cacheCreationInputTokens) ?? 0;
    ledger.set(model, {
      inputTokens: input + cacheRead + cacheWrite,
      outputTokens: output,
      cachedInputTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
    });
  }
  return ledger;
}

/** The window each model in the SDK's `modelUsage` is measured against, as Claude Code resolved it. */
export function claudeReportedContextWindows(modelUsage: unknown): ReadonlyMap<string, number> {
  const windows = new Map<string, number>();
  if (typeof modelUsage !== "object" || modelUsage === null) return windows;
  for (const [model, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
    const window = finiteNonNegativeInteger(
      (entry as Record<string, unknown> | null)?.contextWindow,
    );
    if (window !== undefined && window > 0) windows.set(model, window);
  }
  return windows;
}

/** Ledger growth since `previous`. Unknown without a baseline or when a counter goes backwards. */
export function claudeLedgerDelta(
  previous: ClaudeModelLedger | undefined,
  current: ClaudeModelLedger | undefined,
): ClaudeLedgerUsage | undefined {
  if (previous === undefined || current === undefined) return undefined;
  for (const [model, before] of previous) {
    const after = current.get(model);
    if (
      after === undefined ||
      LEDGER_FIELDS.some((field) => (after[field] ?? 0) < (before[field] ?? 0))
    ) {
      return undefined;
    }
  }
  let growth = EMPTY_CLAUDE_LEDGER_USAGE;
  for (const [model, after] of current) {
    const before = previous.get(model);
    growth = addLedgerCounts(growth, after);
    if (before !== undefined) growth = addLedgerCounts(growth, before, -1);
  }
  return growth;
}

function addLedgerCounts(
  left: ClaudeLedgerUsage,
  right: ClaudeLedgerUsage,
  sign: 1 | -1 = 1,
): Required<ClaudeLedgerUsage> {
  return {
    inputTokens: left.inputTokens + sign * right.inputTokens,
    outputTokens: left.outputTokens + sign * right.outputTokens,
    cachedInputTokens: (left.cachedInputTokens ?? 0) + sign * (right.cachedInputTokens ?? 0),
    cacheCreationTokens: (left.cacheCreationTokens ?? 0) + sign * (right.cacheCreationTokens ?? 0),
  };
}

export function addClaudeLedgerUsage(
  left: ClaudeLedgerUsage | undefined,
  right: ClaudeLedgerUsage | undefined,
): ClaudeLedgerUsage | undefined {
  return left === undefined || right === undefined ? undefined : addLedgerCounts(left, right);
}

export interface ClaudeTurnObservations {
  // Models on the turn's root assistant messages.
  readonly rootModels?: ReadonlySet<string>;
  // Ledger growth across every result this turn consumed, including steered segments.
  readonly ledger?: ClaudeLedgerUsage | undefined;
}

/** Drops the cache split when it disagrees with the totals, so it can never exceed the input. */
function otherLedgerUsage(ledger: ClaudeLedgerUsage, root: ClaudeLedgerUsage) {
  const other = addLedgerCounts(ledger, root, -1);
  const splitKnown =
    other.cachedInputTokens >= 0 &&
    other.cacheCreationTokens >= 0 &&
    other.cachedInputTokens + other.cacheCreationTokens <= other.inputTokens;
  return splitKnown ? other : { inputTokens: other.inputTokens, outputTokens: other.outputTokens };
}

export function normalizeClaudeTurnTokenUsage(
  result:
    | {
        readonly subtype: SDKResultMessage["subtype"];
        readonly usage?: unknown;
        readonly local_command?: unknown;
      }
    | undefined,
  hasSubagents: boolean,
  terminalStatus: RuntimeTurnState,
  earlierSegmentUsage: ReadonlyArray<unknown> = [],
  observed: ClaudeTurnObservations = {},
): TurnTokenUsage {
  const observedFields = {
    ...(observed.rootModels !== undefined && observed.rootModels.size > 0
      ? { models: [...observed.rootModels] }
      : {}),
    ...(typeof result?.local_command === "string" && result.local_command.length > 0
      ? { localCommand: true }
      : {}),
  };
  const finalUsage = result?.usage as Record<string, unknown> | undefined;
  const usage = withEarlierSegmentUsage(finalUsage ?? {}, earlierSegmentUsage);
  const uncachedInputTokens = finiteNonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = finiteNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreationTokens = finiteNonNegativeInteger(usage.cache_creation_input_tokens);
  const rawOutputTokens = finiteNonNegativeInteger(usage.output_tokens);
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const thinkingTokens = finiteNonNegativeInteger(outputDetails?.thinking_tokens);
  const cachedInputContribution = usage.cache_read_input_tokens == null ? 0 : cachedInputTokens;
  const cacheCreationContribution =
    usage.cache_creation_input_tokens == null ? 0 : cacheCreationTokens;
  const inputTokens =
    uncachedInputTokens !== undefined &&
    cachedInputContribution !== undefined &&
    cacheCreationContribution !== undefined
      ? uncachedInputTokens + cachedInputContribution + cacheCreationContribution
      : undefined;
  const hasKnownUsage =
    uncachedInputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheCreationTokens !== undefined ||
    rawOutputTokens !== undefined;
  const hasPositiveUsage =
    (uncachedInputTokens ?? 0) +
      (cachedInputTokens ?? 0) +
      (cacheCreationTokens ?? 0) +
      (rawOutputTokens ?? 0) >
    0;

  if (!hasKnownUsage || (result?.subtype !== "success" && !hasPositiveUsage)) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
      ...observedFields,
    };
  }

  // The result omits subagent and compaction work that the process-wide ledger records.
  const otherUsage =
    observed.ledger !== undefined &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined &&
    observed.ledger.inputTokens >= inputTokens &&
    observed.ledger.outputTokens >= rawOutputTokens
      ? otherLedgerUsage(observed.ledger, {
          inputTokens,
          outputTokens: rawOutputTokens,
          cachedInputTokens: cachedInputContribution ?? 0,
          cacheCreationTokens: cacheCreationContribution ?? 0,
        })
      : undefined;
  const commonUsage = {
    ...observedFields,
    ...(otherUsage === undefined ? {} : { otherUsage }),
    usageScope: "main_agent",
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(thinkingTokens !== undefined && rawOutputTokens !== undefined
      ? { reasoningTokens: Math.min(rawOutputTokens, thinkingTokens) }
      : {}),
    hasSubagents,
  } as const;
  if (
    terminalStatus === "completed" &&
    result?.subtype === "success" &&
    finiteNonNegativeInteger(finalUsage?.input_tokens) !== undefined &&
    finiteNonNegativeInteger(finalUsage?.output_tokens) !== undefined &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined &&
    BILLED_USAGE_FIELDS.every(
      (field) =>
        finalUsage?.[field] == null || finiteNonNegativeInteger(finalUsage[field]) !== undefined,
    )
  ) {
    return {
      ...commonUsage,
      usageStatus: "complete",
      inputTokens,
      outputTokens: rawOutputTokens,
    };
  }
  return {
    ...commonUsage,
    usageStatus: "partial",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(rawOutputTokens !== undefined ? { outputTokens: rawOutputTokens } : {}),
  };
}
