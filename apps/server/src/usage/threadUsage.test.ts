import {
  ProviderDriverKind,
  type OrchestrationV2ProviderTurn,
  type ThreadModelUsage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { summarizeThreadUsage, type ThreadUsagePricing } from "./threadUsage.ts";
import { parseRateTable } from "./usagePricing.ts";

type TurnTokenUsage = NonNullable<OrchestrationV2ProviderTurn["turnTokenUsage"]>;

const PRICING: ThreadUsagePricing = {
  rates: parseRateTable({
    "model-a": {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.00001,
      cache_read_input_token_cost: 0.0000001,
      cache_creation_input_token_cost: 0.000002,
    },
  }),
  priceOverrides: new Map(),
  modelAliases: new Map(),
  status: "fresh",
};

const usage = (fields: Partial<TurnTokenUsage>, driver = "claudeAgent") => ({
  nativeTurnRef: {
    driver: ProviderDriverKind.make(driver),
    nativeId: null,
    strength: "none" as const,
  },
  turnTokenUsage: {
    usageStatus: "complete",
    usageScope: "main_agent",
    hasSubagents: false,
    inputTokens: 0,
    outputTokens: 0,
    ...fields,
  } as TurnTokenUsage,
});

const row = (model: string | null, rows: ReadonlyArray<ThreadModelUsage> | undefined) =>
  rows?.find((entry) => entry.model === model);

describe("summarizeThreadUsage", () => {
  it.each([
    {
      name: "splits cache reads and writes out of the reported input",
      turns: [
        usage({
          models: ["model-a"],
          inputTokens: 1000,
          cachedInputTokens: 700,
          cacheCreationTokens: 200,
          outputTokens: 30,
          reasoningTokens: 50,
        }),
      ],
      model: "model-a",
      expected: {
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 700,
          cacheCreationTokens: 200,
          outputTokens: 30,
          // Reasoning is a subset of output, so it never exceeds it.
          reasoningTokens: 30,
        },
        otherUsage: null,
        priced: true,
        turns: 1,
        // 100 * 1e-6 + 700 * 1e-7 + 200 * 2e-6 + 30 * 1e-5
        costMicros: 870,
      },
      totalTokens: 1030,
      incompleteTurns: 0,
    },
    {
      name: "drops a local command's counters but keeps its subagent and compaction usage",
      turns: [
        usage({
          models: ["model-a"],
          localCommand: true,
          inputTokens: 5000,
          outputTokens: 500,
          otherUsage: { inputTokens: 300, outputTokens: 20 },
        }),
      ],
      model: "model-a",
      expected: {
        totals: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        otherUsage: { inputTokens: 300, outputTokens: 20 },
        priced: true,
        turns: 1,
        // Other usage is priced as uncached input and output: 300 * 1e-6 + 20 * 1e-5
        costMicros: 500,
      },
      totalTokens: 320,
      incompleteTurns: 0,
    },
    {
      name: "keeps turns with several models or none in one unpriced row",
      turns: [
        usage({ models: ["model-a", "model-b"], inputTokens: 40, outputTokens: 4 }),
        usage({
          inputTokens: 10,
          outputTokens: 1,
          otherUsage: { inputTokens: 5, outputTokens: 0 },
        }),
      ],
      model: null,
      expected: {
        totals: {
          uncachedInputTokens: 50,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 5,
          reasoningTokens: 0,
        },
        otherUsage: { inputTokens: 5, outputTokens: 0 },
        priced: false,
        turns: 2,
        costMicros: 0,
      },
      totalTokens: 60,
      incompleteTurns: 0,
    },
    {
      name: "counts partial and unavailable turns as incomplete and keeps what partial ones report",
      turns: [
        usage({
          models: ["model-a"],
          usageStatus: "partial",
          inputTokens: undefined,
          cachedInputTokens: 400,
          outputTokens: 10,
        }),
        usage({
          models: ["model-a"],
          usageStatus: "unavailable",
          inputTokens: undefined,
          outputTokens: undefined,
        }),
      ],
      model: "model-a",
      expected: {
        totals: {
          uncachedInputTokens: 0,
          cachedInputTokens: 400,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
        otherUsage: null,
        priced: true,
        // The unavailable turn reported no tokens, so it adds no turn to the row.
        turns: 1,
        // 400 * 1e-7 + 10 * 1e-5
        costMicros: 140,
      },
      totalTokens: 410,
      incompleteTurns: 2,
    },
    {
      name: "prices an OpenCode turn by the model ID after its provider ID",
      turns: [
        usage({ models: ["cliproxyapi/model-a"], inputTokens: 100, outputTokens: 10 }, "opencode"),
      ],
      model: "model-a",
      expected: {
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
        otherUsage: null,
        priced: true,
        turns: 1,
        // 100 * 1e-6 + 10 * 1e-5
        costMicros: 200,
      },
      totalTokens: 110,
      incompleteTurns: 0,
    },
    {
      name: "keeps a slash inside an OpenCode model ID",
      turns: [
        usage(
          { models: ["openrouter/vendor/model-a"], inputTokens: 100, outputTokens: 10 },
          "opencode",
        ),
      ],
      model: "vendor/model-a",
      expected: {
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
        otherUsage: null,
        priced: false,
        turns: 1,
        costMicros: 0,
      },
      totalTokens: 110,
      incompleteTurns: 0,
    },
    {
      name: "keeps another provider's model ID as reported",
      turns: [usage({ models: ["cliproxyapi/model-a"], inputTokens: 100, outputTokens: 10 })],
      model: "cliproxyapi/model-a",
      expected: {
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
        otherUsage: null,
        priced: false,
        turns: 1,
        costMicros: 0,
      },
      totalTokens: 110,
      incompleteTurns: 0,
    },
  ])("$name", ({ turns, model, expected, totalTokens, incompleteTurns }) => {
    const result = summarizeThreadUsage(turns, PRICING);
    expect(result?.models).toHaveLength(1);
    const { costUsd, ...found } = row(model, result?.models)!;
    expect({ ...found, costMicros: Math.round(costUsd * 1e6) }).toEqual({ model, ...expected });
    expect(result?.totalTokens).toBe(totalTokens);
    expect(result?.incompleteTurns).toBe(incompleteTurns);
  });

  it("is null when every reporting turn reported no tokens", () => {
    expect(
      summarizeThreadUsage(
        [usage({ usageStatus: "unavailable", inputTokens: undefined, outputTokens: undefined })],
        PRICING,
      ),
    ).toBeNull();
  });
});
