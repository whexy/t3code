// Bounded exhaustive check of summarizeThreadUsage. Procedure and scope: .agents/skills/verify-thread-usage/SKILL.md
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, type ThreadUsage, type TurnTokenUsage } from "@t3tools/contracts";

import { summarizeThreadUsage, type ThreadUsagePricing } from "./threadUsage.ts";
import { createOverrideRateTable, parseRateTable } from "./usagePricing.ts";

const CLAUDE = "claude-opus-5-5";
const CODEX = "gpt-5.5-codex";
const ALIASED = "opus-internal";
const UNPRICED = "mystery-model";
const UNPRICED_TWIN = "mystery-twin";

// Per-token rates the oracle prices with, written out independently of usagePricing.
const RATES: Record<
  string,
  { input: number; cacheRead: number; cacheWrite: number; output: number }
> = {
  [CLAUDE]: { input: 3e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6, output: 1.5e-5 },
  // The override replaces the table's codex rate; its omitted cache write falls back to input.
  [CODEX]: { input: 2e-6, cacheRead: 5e-7, cacheWrite: 2e-6, output: 8e-6 },
};
const ALIASES: Record<string, string> = { [ALIASED]: CLAUDE };

const pricing: ThreadUsagePricing = {
  rates: parseRateTable({
    [CLAUDE]: {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 1.5e-5,
      cache_read_input_token_cost: 3e-7,
      cache_creation_input_token_cost: 3.75e-6,
    },
    [CODEX]: { input_cost_per_token: 1, output_cost_per_token: 1 },
  }),
  priceOverrides: createOverrideRateTable({
    [CODEX]: {
      inputCostPerMillionTokens: 2,
      outputCostPerMillionTokens: 8,
      cacheReadCostPerMillionTokens: 0.5,
    },
  }),
  modelAliases: new Map(Object.entries(ALIASES)),
  status: "fresh",
};

const base = { usageScope: "main_agent", hasSubagents: false } as const;

/**
 * The turn alphabet. Distinct counts per kind expose misattribution; the two unpriced kinds tie
 * on cost and tokens so the sort's model tiebreak is exercised.
 */
const KINDS: ReadonlyArray<{
  readonly name: string;
  readonly usage: TurnTokenUsage | undefined;
  readonly driver?: string;
}> = [
  { name: "no usage reported", usage: undefined },
  {
    name: "claude complete with cache",
    usage: {
      ...base,
      usageStatus: "complete",
      models: [CLAUDE],
      inputTokens: 1000,
      cachedInputTokens: 300,
      cacheCreationTokens: 200,
      outputTokens: 50,
      reasoningTokens: 20,
    },
  },
  {
    name: "codex complete, reasoning above output",
    usage: {
      ...base,
      usageStatus: "complete",
      models: [CODEX],
      inputTokens: 700,
      cachedInputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 40,
    },
  },
  {
    name: "aliased model with subagent usage",
    usage: {
      ...base,
      hasSubagents: true,
      usageStatus: "complete",
      models: [ALIASED],
      inputTokens: 90,
      outputTokens: 9,
      otherUsage: {
        inputTokens: 400,
        outputTokens: 40,
        cachedInputTokens: 300,
        cacheCreationTokens: 50,
      },
    },
  },
  {
    name: "claude subagent cache split larger than its input",
    usage: {
      ...base,
      hasSubagents: true,
      usageStatus: "complete",
      models: [CLAUDE],
      inputTokens: 41,
      outputTokens: 4,
      otherUsage: {
        inputTokens: 80,
        outputTokens: 8,
        cachedInputTokens: 60,
        cacheCreationTokens: 30,
      },
    },
  },
  {
    name: "claude partial, input and output absent",
    usage: { ...base, usageStatus: "partial", models: [CLAUDE], cachedInputTokens: 60 },
  },
  { name: "unavailable, no model", usage: { ...base, usageStatus: "unavailable" } },
  {
    name: "unpriced model with other usage",
    usage: {
      ...base,
      usageStatus: "complete",
      models: [UNPRICED],
      inputTokens: 55,
      outputTokens: 5,
      otherUsage: { inputTokens: 11, outputTokens: 1 },
    },
  },
  {
    name: "two models in one turn",
    usage: {
      ...base,
      usageStatus: "complete",
      models: [CLAUDE, CODEX],
      inputTokens: 33,
      outputTokens: 3,
    },
  },
  {
    name: "claude local command with compaction usage",
    usage: {
      ...base,
      usageStatus: "complete",
      models: [CLAUDE],
      localCommand: true,
      inputTokens: 500,
      outputTokens: 5,
      otherUsage: { inputTokens: 70, outputTokens: 7 },
    },
  },
  {
    name: "codex partial, input below cached plus creation",
    usage: {
      ...base,
      usageStatus: "partial",
      models: [CODEX],
      inputTokens: 20,
      cachedInputTokens: 50,
      cacheCreationTokens: 10,
      outputTokens: 2,
    },
  },
  {
    name: "no model, zero other usage",
    usage: {
      ...base,
      usageStatus: "complete",
      models: [],
      inputTokens: 13,
      outputTokens: 1,
      otherUsage: { inputTokens: 0, outputTokens: 0 },
    },
  },
  {
    name: "claude complete, all counters zero",
    usage: {
      ...base,
      usageStatus: "complete",
      models: [CLAUDE],
      inputTokens: 0,
      outputTokens: 0,
    },
  },
  {
    name: "codex id with surrounding whitespace",
    usage: {
      ...base,
      usageStatus: "complete",
      models: [` ${CODEX} `],
      inputTokens: 7,
      outputTokens: 1,
    },
  },
  {
    name: "second unpriced model tying the first",
    usage: {
      ...base,
      usageStatus: "complete",
      models: [UNPRICED_TWIN],
      inputTokens: 55,
      outputTokens: 5,
      otherUsage: { inputTokens: 11, outputTokens: 1 },
    },
  },
  {
    name: "opencode turn naming claude behind its provider id",
    driver: "opencode",
    usage: {
      ...base,
      usageStatus: "complete",
      models: [`gateway/${CLAUDE}`],
      inputTokens: 21,
      outputTokens: 2,
    },
  },
];

const MAX_TURNS = 5;
const MAX_PERMUTED_TURNS = 4;

interface OracleRow {
  uncached: number;
  cached: number;
  creation: number;
  output: number;
  reasoning: number;
  otherInput: number;
  otherOutput: number;
  turns: number;
}

/** Cache tokens inside a row's other input; the row does not report them, but its cost uses them. */
interface OracleOtherCache {
  cached: number;
  creation: number;
}

function oracleKey(usage: TurnTokenUsage, driver: string | undefined): string | null {
  const models = usage.models ?? [];
  if (models.length !== 1) return null;
  const reported = models[0]!.trim();
  if (reported === "") return null;
  // OpenCode provider ids hold no slash, so the model id is everything after the first one.
  const slash = reported.indexOf("/");
  const model =
    driver === "opencode" && slash > 0 && slash < reported.length - 1
      ? reported.slice(slash + 1)
      : reported;
  return ALIASES[model] ?? model;
}

function oracle(kinds: ReadonlyArray<(typeof KINDS)[number]>) {
  const rows = new Map<string | null, OracleRow>();
  const otherCache = new Map<string | null, OracleOtherCache>();
  let incomplete = 0;
  for (const { usage, driver } of kinds) {
    if (usage === undefined) continue;
    if (usage.usageStatus !== "complete") incomplete += 1;
    const local = usage.localCommand === true;
    const cached = local ? 0 : (usage.cachedInputTokens ?? 0);
    const creation = local ? 0 : (usage.cacheCreationTokens ?? 0);
    const output = local ? 0 : (usage.outputTokens ?? 0);
    const uncached = local ? 0 : Math.max(0, (usage.inputTokens ?? 0) - cached - creation);
    const reasoning = local ? 0 : Math.min(usage.reasoningTokens ?? 0, output);
    const otherInput = usage.otherUsage?.inputTokens ?? 0;
    const otherOutput = usage.otherUsage?.outputTokens ?? 0;
    // A split that cannot fit inside the other input is unknown, so that input is all uncached.
    const otherCached = usage.otherUsage?.cachedInputTokens ?? 0;
    const otherCreation = usage.otherUsage?.cacheCreationTokens ?? 0;
    const splitFits = otherCached + otherCreation <= otherInput;
    if (uncached + cached + creation + output + otherInput + otherOutput === 0) continue;
    const key = oracleKey(usage, driver);
    const row = rows.get(key) ?? {
      uncached: 0,
      cached: 0,
      creation: 0,
      output: 0,
      reasoning: 0,
      otherInput: 0,
      otherOutput: 0,
      turns: 0,
    };
    row.uncached += uncached;
    row.cached += cached;
    row.creation += creation;
    row.output += output;
    row.reasoning += reasoning;
    row.otherInput += otherInput;
    row.otherOutput += otherOutput;
    row.turns += 1;
    rows.set(key, row);
    const cache = otherCache.get(key) ?? { cached: 0, creation: 0 };
    if (splitFits) {
      cache.cached += otherCached;
      cache.creation += otherCreation;
    }
    otherCache.set(key, cache);
  }
  return { rows, otherCache, incomplete };
}

function oracleCost(key: string | null, row: OracleRow, cache: OracleOtherCache): number | null {
  const rate = key === null ? undefined : RATES[key];
  if (rate === undefined) return null;
  return (
    (row.uncached + row.otherInput - cache.cached - cache.creation) * rate.input +
    (row.cached + cache.cached) * rate.cacheRead +
    (row.creation + cache.creation) * rate.cacheWrite +
    (row.output + row.otherOutput) * rate.output
  );
}

const rowTokens = (row: OracleRow) =>
  row.uncached + row.cached + row.creation + row.output + row.otherInput + row.otherOutput;

const close = (actual: number, expected: number) =>
  Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected));

function* sequences(length: number): Generator<number[]> {
  if (length === 0) {
    yield [];
    return;
  }
  for (const prefix of sequences(length - 1)) {
    for (let kind = 0; kind < KINDS.length; kind += 1) yield [...prefix, kind];
  }
}

function* permutations(items: readonly number[]): Generator<number[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) yield [items[index]!, ...tail];
  }
}

const describeSequence = (sequence: readonly number[]) =>
  sequence.length === 0 ? "(no turns)" : sequence.map((kind) => KINDS[kind]!.name).join(" -> ");

function summarize(sequence: readonly number[]): ThreadUsage | null {
  return summarizeThreadUsage(
    sequence.map((kind) => {
      const { usage, driver = "claudeAgent" } = KINDS[kind]!;
      return {
        turnTokenUsage: usage,
        nativeTurnRef: {
          driver: ProviderDriverKind.make(driver),
          nativeId: null,
          strength: "none",
        },
      };
    }),
    pricing,
  );
}

/** Returns the first broken property for a sequence, or null when every property holds. */
function violation(sequence: readonly number[]): string | null {
  const result = summarize(sequence);
  const expected = oracle(sequence.map((kind) => KINDS[kind]!));

  // status: hidden exactly when no turn contributes a token.
  if ((result === null) !== (expected.rows.size === 0)) {
    return `status: result is ${result === null ? "null" : "present"} but ${expected.rows.size} rows contribute tokens`;
  }
  if (result === null) return null;
  if (result.incompleteTurns !== expected.incomplete) {
    return `status: incompleteTurns ${result.incompleteTurns}, expected ${expected.incomplete}`;
  }

  // attribution: exactly one row per contributing (aliased) model, null for unknown or several.
  const keys = result.models.map((row) => row.model);
  if (new Set(keys).size !== keys.length)
    return `attribution: duplicate rows ${JSON.stringify(keys)}`;
  if (keys.length !== expected.rows.size || keys.some((key) => !expected.rows.has(key))) {
    return `attribution: rows ${JSON.stringify(keys)}, expected ${JSON.stringify([...expected.rows.keys()])}`;
  }

  let tokenSum = 0;
  let costSum = 0;
  for (const row of result.models) {
    const want = expected.rows.get(row.model)!;
    const got = {
      uncached: row.totals.uncachedInputTokens,
      cached: row.totals.cachedInputTokens,
      creation: row.totals.cacheCreationTokens,
      output: row.totals.outputTokens,
      reasoning: row.totals.reasoningTokens,
      otherInput: row.otherUsage?.inputTokens ?? 0,
      otherOutput: row.otherUsage?.outputTokens ?? 0,
      turns: row.turns,
    };
    // conservation: each row holds exactly its turns' tokens, split the same way.
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      return `conservation: row ${row.model} has ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
    }
    if (row.otherUsage !== null && row.otherUsage.inputTokens + row.otherUsage.outputTokens === 0) {
      return `conservation: row ${row.model} carries an empty otherUsage instead of null`;
    }
    tokenSum += rowTokens(want);

    // cost: priced rows match the oracle's rates; unpriced and unknown rows cost 0.
    const cost = oracleCost(row.model, want, expected.otherCache.get(row.model)!);
    if (row.priced !== (cost !== null)) return `cost: row ${row.model} priced=${row.priced}`;
    if (!close(row.costUsd, cost ?? 0)) {
      return `cost: row ${row.model} costs ${row.costUsd}, expected ${cost ?? 0}`;
    }
    costSum += row.costUsd;
  }
  if (result.totalTokens !== tokenSum) {
    return `conservation: totalTokens ${result.totalTokens}, rows and turns sum to ${tokenSum}`;
  }
  if (!close(result.costUsd, costSum)) {
    return `cost: costUsd ${result.costUsd}, rows sum to ${costSum}`;
  }

  // order: the unknown-model row comes last; others by cost, then tokens, then model id.
  for (let index = 1; index < result.models.length; index += 1) {
    const a = result.models[index - 1]!;
    const b = result.models[index]!;
    if (a.model === null) return "order: the unknown-model row is not last";
    if (b.model === null) continue;
    const aTokens = rowTokens(expected.rows.get(a.model)!);
    const bTokens = rowTokens(expected.rows.get(b.model)!);
    const ordered =
      a.costUsd > b.costUsd ||
      (a.costUsd === b.costUsd &&
        (aTokens > bTokens || (aTokens === bTokens && a.model < b.model)));
    if (!ordered) return `order: ${a.model} sorted before ${b.model}`;
  }
  return null;
}

describe("summarizeThreadUsage, every turn sequence up to the bound", () => {
  it(`holds conservation, attribution, cost and status for up to ${MAX_TURNS} turns`, () => {
    let checked = 0;
    for (let length = 0; length <= MAX_TURNS; length += 1) {
      for (const sequence of sequences(length)) {
        checked += 1;
        const broken = violation(sequence);
        if (broken !== null) {
          expect.fail(`${broken}\n  turns: ${describeSequence(sequence)}`);
        }
      }
    }
    expect(checked).toBe(
      Array.from({ length: MAX_TURNS + 1 }, (_, length) => KINDS.length ** length).reduce(
        (sum, count) => sum + count,
      ),
    );
  });

  it(`gives the same rows in the same order for every ordering of up to ${MAX_PERMUTED_TURNS} turns`, () => {
    let orderings = 0;
    for (let length = 2; length <= MAX_PERMUTED_TURNS; length += 1) {
      for (const sequence of sequences(length)) {
        const reference = JSON.stringify(summarize(sequence));
        for (const permuted of permutations(sequence)) {
          orderings += 1;
          if (JSON.stringify(summarize(permuted)) !== reference) {
            expect.fail(
              `order: result changed when turns were reordered\n  turns: ${describeSequence(sequence)}\n  reordered: ${describeSequence(permuted)}`,
            );
          }
        }
      }
    }
    expect(orderings).toBeGreaterThan(KINDS.length ** MAX_PERMUTED_TURNS);
  });

  it("keeps both harnesses when a thread switches from Claude to Codex", () => {
    const models = summarize([1, 2])?.models.map((row) => row.model);
    expect(new Set(models)).toEqual(new Set([CLAUDE, CODEX]));
  });
});
