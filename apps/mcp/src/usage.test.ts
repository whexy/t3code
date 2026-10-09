import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageBucket,
  type UsageSummary,
} from "@t3tools/contracts";
import type { EnvironmentUsage } from "@t3tools/shared/usageMerge";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tool from "effect/ai/Tool";

import { BridgeError, Environments, type T3Environment } from "./environment.ts";
import { fakeEnvironment } from "./testing.ts";
import { BridgeToolkit, BridgeToolkitHandlersLive } from "./tools.ts";
import { GetUsageTool, usageReport, usageWindow } from "./usage.ts";

const encodeUsage = Schema.encodeSync(GetUsageTool.successSchema);

const input = { since_day: "2026-03-01", until_day: "2026-03-31", time_zone: "America/Chicago" };
const bucket = (overrides: Partial<UsageBucket> = {}): UsageBucket => ({
  day: UsageDay.make("2026-03-08"),
  provider: "codex",
  model: "gpt-5",
  sourcePath: "/history",
  totals: {
    uncachedInputTokens: 100,
    cachedInputTokens: 50,
    cacheCreationTokens: 20,
    outputTokens: 30,
    reasoningTokens: 10,
  },
  costUsd: 2,
  cacheSavingsUsd: 0.5,
  costSource: "modelPriced",
  records: 2,
  unpricedRecords: 1,
  sessions: 1,
  ...overrides,
});
const summary = (overrides: Partial<UsageSummary> = {}): UsageSummary => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-03-31T12:00:00Z",
  timeZone: input.time_zone,
  sinceDay: UsageDay.make(input.since_day),
  untilDay: UsageDay.make(input.until_day),
  buckets: [bucket(), bucket({ day: UsageDay.make("2026-03-09"), model: "gpt-6" })],
  sources: [
    {
      fingerprint: {
        hostId: "host",
        provider: "codex",
        resolvedHomePath: "/history",
        volumeId: "1:2",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: { status: "cached", source: "LiteLLM", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
  ...overrides,
});
const entry = (id: string, value = summary()): EnvironmentUsage => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  summary: value,
});

describe("usage windows", () => {
  it("keeps inclusive calendar bounds and rejects nonexistent dates, zones and ambiguous parameters", () => {
    expect(usageWindow(input)).toEqual({
      sinceDay: input.since_day,
      untilDay: input.until_day,
      timeZone: input.time_zone,
      resolution: "day",
    });
    for (const invalid of [
      { since_day: "2026-02-30" },
      { until_day: "2026-03-32" },
      { since_day: "2026-04-01" },
      { time_zone: "Invalid/Zone" },
      { time_zone: "+05:00" },
      { since_day: "2000-01-01" },
      { since_time: "2026-03-01T00:00:00Z" },
      { group_by: ["hour"] as const },
      { group_by: ["day", "day"] as const },
    ])
      expect(() => usageWindow({ ...input, ...invalid })).toThrow(BridgeError);
  });

  it("normalizes offset instants across DST and enforces the canonical hourly limit", () => {
    const hourly = {
      ...input,
      since_day: "2026-03-08",
      until_day: "2026-03-09",
      resolution: "hour" as const,
      since_time: "2026-03-08T00:00:00-06:00",
      until_time: "2026-03-09T00:00:00-05:00",
      group_by: ["hour"] as const,
    };
    expect(usageWindow(hourly)).toMatchObject({
      sinceTime: "2026-03-08T06:00:00.000Z",
      untilTime: "2026-03-09T05:00:00.000Z",
    });
    for (const invalid of [
      { until_time: "2026-03-09T02:00:00-05:00" },
      { since_time: "2026-03-08T00:00:00" },
      { since_day: "2026-03-07" },
      { until_time: hourly.since_time },
      { group_by: ["day", "hour"] as const },
    ])
      expect(() => usageWindow({ ...hourly, ...invalid })).toThrow(BridgeError);
  });
});

describe("canonical usage reports", () => {
  it("deduplicates shared histories and never adds reasoning or per-cell session counts", () => {
    const report = usageReport([entry("a"), entry("b")], { ...input, group_by: ["model"] });
    expect(report.totals).toMatchObject({
      totalTokens: 400,
      outputTokens: 60,
      reasoningTokens: 20,
      costUsd: 4,
      cacheSavingsUsd: 1,
      sessions: 1,
      records: 4,
      unpricedRecords: 2,
    });
    expect(report.groups).toHaveLength(2);
    expect(report.groups.map((group) => group.metrics.sessions)).toEqual([null, null]);
    expect(report.groups.reduce((sum, group) => sum + group.metrics.totalTokens, 0)).toBe(400);
    expect(report.duplicate_sources).toHaveLength(1);
    expect(report.contributing_servers).toEqual(["a"]);
  });

  it("preserves complete source ownership in groups and supplements only absent partial cells", () => {
    const complete = summary({ buckets: [bucket()] });
    const partial = summary({
      readAt: "2026-03-31T13:00:00Z",
      sources: [{ ...complete.sources[0]!, status: "partial" }],
      buckets: [
        bucket({ costUsd: 100 }),
        bucket({ day: UsageDay.make("2026-03-09"), model: "gpt-6" }),
      ],
    });
    const report = usageReport([entry("a", complete), entry("b", partial)], {
      ...input,
      group_by: ["day", "model"],
    });
    expect(report.totals.costUsd).toBe(4);
    expect(report.groups.map((group) => group.metrics.costUsd)).toEqual([2, 2]);
  });

  it("filters exact provider/model IDs and leaves unavailable session counts unknown", () => {
    const report = usageReport([entry("a")], {
      ...input,
      models: ["gpt-6"],
      providers: ["codex"],
      group_by: ["provider"],
    });
    expect(report.totals).toMatchObject({ totalTokens: 200, sessions: null });
    expect(report.groups[0]).toMatchObject({ provider: "codex", metrics: { sessions: null } });
    expect(usageReport([entry("a")], { ...input, providers: ["claude"] }).totals).toMatchObject({
      totalTokens: 0,
      sessions: 0,
    });
    expect(usageReport([entry("a")], { ...input, models: ["GPT-6"] }).totals.totalTokens).toBe(0);
    expect(
      usageReport([entry("a")], { ...input, group_by: ["provider"] }).groups[0]?.metrics.sessions,
    ).toBe(1);
  });

  it("retains unpriced usage and exposes missing-source coverage without inventing records", () => {
    const value = summary({
      buckets: [bucket({ costUsd: 0, costSource: "unpriced", unpricedRecords: 2 })],
    });
    const report = usageReport([entry("a", value)], input);
    expect(report.totals).toMatchObject({
      costUsd: 0,
      totalTokens: 200,
      records: 2,
      unpricedRecords: 2,
    });
    const missing = summary({
      buckets: [],
      sources: [{ ...value.sources[0]!, status: "missing", distinctSessions: 0 }],
    });
    expect(usageReport([entry("a", missing)], input).totals).toMatchObject({
      totalTokens: 0,
      sessions: 0,
      records: 0,
    });
  });

  it("bounds returned groups without truncating totals and reports incompatible servers", () => {
    const entries = [entry("a"), entry("old", summary({ contractVersion: 1 }))];
    const first = usageReport(entries, { ...input, group_by: ["day"], limit: 1 });
    const second = usageReport(entries, { ...input, group_by: ["day"], limit: 1, offset: 1 });
    expect(first.totals.totalTokens).toBe(400);
    expect(first.total_groups).toBe(2);
    expect(first.next_offset).toBe(1);
    expect(second.next_offset).toBeNull();
    expect(second.groups[0]?.day).toBe("2026-03-09");
    expect(first.contract_mismatches).toEqual([
      { server_id: "old", direction: "serverBehind", contract_version: 1 },
    ]);
  });

  it("keeps repeated DST hours distinct by UTC instant", () => {
    const value = summary({
      buckets: [
        bucket({ hourStart: "2026-11-01T06:00:00Z" }),
        bucket({ hourStart: "2026-11-01T07:00:00Z" }),
      ],
    });
    const report = usageReport([entry("a", value)], {
      ...input,
      resolution: "hour",
      group_by: ["hour", "provider"],
    });
    expect(report.groups.map((group) => group.hour)).toEqual([
      "2026-11-01T06:00:00Z",
      "2026-11-01T07:00:00Z",
    ]);
  });
});

it.effect(
  "exposes a read-only structured tool, sends canonical queries, and retains errors/coverage",
  () =>
    Effect.gen(function* () {
      const queries: Array<unknown> = [];
      // Every other server call dies, so the tool can neither read sessions nor run agents.
      const environment = (id: string): T3Environment =>
        fakeEnvironment({
          id,
          name: id,
          expiresAt: "2026-10-01T00:00:00Z",
          usageSummary: (window) => {
            queries.push(window);
            return id === "offline"
              ? Effect.fail(new BridgeError({ message: "unreachable" }))
              : Effect.succeed(summary());
          },
        });
      const environments = Environments.of({
        enabled: Effect.succeed([environment("home"), environment("offline")]),
        get: (id) =>
          id === "home"
            ? Effect.succeed(environment(id))
            : Effect.fail(new BridgeError({ message: "Unknown server_id" })),
      });
      const handlers = BridgeToolkitHandlersLive.pipe(
        Layer.provide(Layer.succeed(Environments, environments)),
        Layer.provide(NodeServices.layer),
      );
      const call = (args: typeof GetUsageTool.parametersSchema.Type) =>
        Effect.gen(function* () {
          const toolkit = yield* BridgeToolkit;
          const results = yield* toolkit
            .handle("get_usage", args)
            .pipe(Effect.flatMap(Stream.runCollect));
          const result = results[0]!.result;
          return "totals" in result ? result : yield* Effect.die(result);
        }).pipe(Effect.provide(handlers));
      const result = yield* call({
        ...input,
        server_id: null,
        group_by: ["provider", "model"],
        limit: null,
      });
      expect(queries).toEqual([usageWindow(input), usageWindow(input)]);
      expect(result.servers).toEqual([
        expect.objectContaining({
          server_id: "home",
          sources: summary().sources,
          pricing: summary().pricing,
        }),
        { server_id: "offline", name: "offline", error: "unreachable", sources: [] },
      ]);
      expect(result.totals.totalTokens).toBe(400);
      expect(encodeUsage(result)).toMatchObject({
        totals: { totalTokens: 400 },
      });
      expect(Context.get(GetUsageTool.annotations, Tool.Readonly)).toBe(true);
      queries.length = 0;
      yield* call({ ...input, server_id: "home" });
      expect(queries).toHaveLength(1);
      expect((yield* Effect.flip(call({ ...input, server_id: "unknown" }))).message).toContain(
        "Unknown server_id",
      );
      queries.length = 0;
      expect((yield* Effect.flip(call({ ...input, time_zone: "bad" }))).message).toContain(
        "time_zone",
      );
      expect(queries).toEqual([]);
    }),
);
