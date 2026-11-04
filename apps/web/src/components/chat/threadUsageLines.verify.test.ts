// Exhaustive check of threadUsageView. Procedure and scope: .agents/skills/verify-thread-usage/SKILL.md
import type { ThreadModelUsage, ThreadUsage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadUsageView } from "./threadUsageLines";

const totals = (uncached: number, cached: number, creation: number, output: number) => ({
  uncachedInputTokens: uncached,
  cachedInputTokens: cached,
  cacheCreationTokens: creation,
  outputTokens: output,
  reasoningTokens: 0,
});

const ROWS: readonly ThreadModelUsage[] = [
  {
    model: "claude-opus-5-5",
    totals: totals(500, 300, 200, 50),
    otherUsage: null,
    costUsd: 0.0042,
    priced: true,
    turns: 2,
  },
  {
    model: "gpt-5.5-codex",
    totals: totals(600, 100, 0, 30),
    otherUsage: null,
    costUsd: 0.0013,
    priced: true,
    turns: 1,
  },
  {
    model: "mystery-model",
    totals: totals(55, 0, 0, 5),
    otherUsage: { inputTokens: 11, outputTokens: 1 },
    costUsd: 0,
    priced: false,
    turns: 1,
  },
  {
    model: null,
    totals: totals(33, 0, 0, 3),
    otherUsage: null,
    costUsd: 0,
    priced: false,
    turns: 1,
  },
  {
    model: "claude-sonnet-5-5",
    totals: totals(90, 0, 0, 9),
    otherUsage: { inputTokens: 400, outputTokens: 40 },
    costUsd: 0.0021,
    priced: true,
    turns: 3,
  },
];

const rowTokens = (row: ThreadModelUsage) =>
  row.totals.uncachedInputTokens +
  row.totals.cachedInputTokens +
  row.totals.cacheCreationTokens +
  row.totals.outputTokens +
  (row.otherUsage === null ? 0 : row.otherUsage.inputTokens + row.otherUsage.outputTokens);

const close = (actual: number, expected: number) =>
  Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected));

/** Every ordered selection of distinct rows, sizes 0 through all of them. */
function* selections(pool: readonly number[]): Generator<number[]> {
  yield [];
  for (let index = 0; index < pool.length; index += 1) {
    const rest = [...pool.slice(0, index), ...pool.slice(index + 1)];
    for (const tail of selections(rest)) yield [pool[index]!, ...tail];
  }
}

function usageOf(
  rows: readonly ThreadModelUsage[],
  incompleteTurns: number,
  pricing: ThreadUsage["pricing"],
): ThreadUsage {
  return {
    models: rows,
    totalTokens: rows.reduce((sum, row) => sum + rowTokens(row), 0),
    costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
    incompleteTurns,
    pricing,
  };
}

function violation(supported: boolean, usage: ThreadUsage | null): string | null {
  const view = threadUsageView({ supported, usage });
  const shouldHide = !supported || usage === null || usage.models.length === 0;
  if ((view === null) !== shouldHide) {
    return `hidden: view is ${view === null ? "hidden" : "shown"}`;
  }
  if (view === null || usage === null) return null;
  if (view.incompleteTurns !== usage.incompleteTurns || view.pricing !== usage.pricing) {
    return "status: incompleteTurns or pricing not passed through";
  }
  const keys = view.lines.map((line) => line.key);
  if (new Set(keys).size !== keys.length) return `lines: duplicate keys ${JSON.stringify(keys)}`;

  const rows = usage.models;
  if (rows.length === 1) {
    const [line] = view.lines;
    const row = rows[0]!;
    if (view.lines.length !== 1 || line!.kind !== "model") {
      return `single model: expected one combined line, got ${JSON.stringify(view.lines.map((l) => l.kind))}`;
    }
    if (
      line!.model !== row.model ||
      line!.tokens !== usage.totalTokens ||
      !close(line!.costUsd, usage.costUsd) ||
      line!.priced !== row.priced ||
      line!.usage !== row
    ) {
      return "single model: the line does not carry the thread's totals and the model's breakdown";
    }
    return null;
  }

  if (view.lines.length !== rows.length + 1) {
    return `several models: ${view.lines.length} lines for ${rows.length} models`;
  }
  for (const [index, row] of rows.entries()) {
    const line = view.lines[index]!;
    if (
      line.kind !== "model" ||
      line.model !== row.model ||
      line.tokens !== rowTokens(row) ||
      line.costUsd !== row.costUsd ||
      line.priced !== row.priced ||
      line.usage !== row
    ) {
      return `several models: line ${index} does not match model ${row.model}`;
    }
  }
  const total = view.lines.at(-1)!;
  if (total.kind !== "total" || total.usage !== null || total.model !== null) {
    return "several models: the last line is not the total";
  }
  if (view.lines.filter((line) => line.kind === "total").length !== 1) {
    return "several models: more than one total line";
  }
  const tokenSum = rows.reduce((sum, row) => sum + rowTokens(row), 0);
  const costSum = rows.reduce((sum, row) => sum + row.costUsd, 0);
  if (total.tokens !== tokenSum || !close(total.costUsd, costSum)) {
    return `several models: total ${total.tokens} tokens / $${total.costUsd}, rows sum to ${tokenSum} / $${costSum}`;
  }
  if (total.priced !== rows.every((row) => row.priced)) {
    return `several models: total priced=${total.priced} though rows are ${JSON.stringify(rows.map((row) => row.priced))}`;
  }
  return null;
}

describe("threadUsageView, every row combination", () => {
  it("hides, combines a single model, or lists models with a total", () => {
    let checked = 0;
    const indexes = ROWS.map((_, index) => index);
    for (const supported of [true, false]) {
      const inputs: Array<ThreadUsage | null> = [null];
      for (const selection of selections(indexes)) {
        for (const incompleteTurns of [0, 2]) {
          for (const pricing of ["fresh", "unavailable"] as const) {
            inputs.push(
              usageOf(
                selection.map((index) => ROWS[index]!),
                incompleteTurns,
                pricing,
              ),
            );
          }
        }
      }
      for (const usage of inputs) {
        checked += 1;
        const broken = violation(supported, usage);
        if (broken !== null) {
          expect.fail(
            `${broken}\n  supported=${supported} models=${JSON.stringify(usage?.models.map((row) => row.model) ?? "no data")}`,
          );
        }
      }
    }
    // 326 ordered selections of 5 rows (including none), 4 status variants each, plus no data.
    expect(checked).toBe(2 * (1 + 326 * 4));
  });
});
