// @effect-diagnostics globalDate:off - Validates explicit caller dates; never reads the host clock.
import {
  EnvironmentId,
  NonNegativeInt,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  UsagePricing,
  UsageProviderKind,
  UsageSource,
  UsageSummaryInput,
  UsageTokenTotals,
} from "@t3tools/contracts";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";

import { BridgeError, type Environments } from "./environment.ts";

const optional = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));
const text = (description: string) =>
  Schema.String.check(Schema.isMinLength(1)).annotate({ description });
const Dimension = Schema.Literals(["provider", "model", "day", "hour"]);
const Parameters = Schema.Struct({
  server_id: optional(
    text(
      "server_id from list_projects; omit to merge all enabled servers, deduplicating shared history.",
    ),
  ),
  since_day: text(
    "Inclusive first calendar date, YYYY-MM-DD, in time_zone. For last 30 days, use today minus 29 calendar days.",
  ),
  until_day: text(
    "Inclusive last calendar date, YYYY-MM-DD, in time_zone. For today use the same date as since_day; for this week use the desired week's start through today.",
  ),
  time_zone: text(
    "Explicit IANA timezone, e.g. America/Chicago or UTC; never defaults to the server's timezone.",
  ),
  resolution: optional(
    Schema.Literals(["day", "hour"]).annotate({
      description:
        "day (default) uses inclusive calendar dates. hour requires exact since_time/until_time and at most 24 hours.",
    }),
  ),
  since_time: optional(
    text(
      "Hourly only: ISO 8601 instant with Z or numeric offset, inclusive. Buckets are fixed 60-minute periods anchored here, not wall-clock hours.",
    ),
  ),
  until_time: optional(
    text(
      "Hourly only: ISO 8601 instant with Z or numeric offset, exclusive. Overrides date boundaries for hourly selection; dates must match the instants in time_zone.",
    ),
  ),
  providers: optional(
    Schema.Array(UsageProviderKind).check(Schema.isMinLength(1)).annotate({
      description: "Only these provider kinds (agent runtimes), not configured agent/account IDs.",
    }),
  ),
  models: optional(
    Schema.Array(text("Exact model ID as reported by Usage."))
      .check(Schema.isMinLength(1))
      .annotate({
        description:
          "Exact, case-sensitive model IDs; model names remain attributed to their provider. Filtered distinct session counts are unavailable.",
      }),
  ),
  group_by: optional(
    Schema.Array(Dimension).check(Schema.isMaxLength(3)).annotate({
      description:
        "Default [] returns only totals. Combine provider, model and day, or provider, model and hour (hourly resolution only). Groups contain usage only; missing periods have no observed records.",
    }),
  ),
  offset: optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description:
        "Group offset, default 0. Follow next_offset; each call rescans, so pagination is not a frozen snapshot.",
    }),
  ),
  limit: optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description:
        "Maximum groups returned, default 50, maximum 100. Totals always cover the entire filtered range.",
    }),
  ),
});

const Metrics = Schema.Struct({
  ...UsageTokenTotals.fields,
  totalTokens: NonNegativeInt,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  sessions: Schema.NullOr(NonNegativeInt),
});
const Success = Schema.Struct({
  window: UsageSummaryInput,
  filters: Schema.Struct({
    providers: Schema.Array(UsageProviderKind),
    models: Schema.Array(Schema.String),
  }),
  group_by: Schema.Array(Dimension),
  totals: Metrics,
  groups: Schema.Array(
    Schema.Struct({
      provider: Schema.optional(UsageProviderKind),
      model: Schema.optional(Schema.String),
      day: Schema.optional(Schema.String),
      hour: Schema.optional(Schema.String),
      metrics: Metrics,
    }),
  ),
  total_groups: NonNegativeInt,
  next_offset: Schema.NullOr(NonNegativeInt),
  servers: Schema.Array(
    Schema.Struct({
      server_id: Schema.String,
      name: Schema.String,
      error: Schema.optional(Schema.String),
      read_at: Schema.optional(Schema.String),
      contract_version: Schema.optional(Schema.Number),
      sources: Schema.Array(UsageSource),
      pricing: Schema.optional(UsagePricing),
    }),
  ),
  duplicate_sources: Schema.Array(Schema.String),
  contributing_servers: Schema.Array(Schema.String),
  contract_mismatches: Schema.Array(
    Schema.Struct({
      server_id: Schema.String,
      direction: Schema.Literals(["serverBehind", "clientBehind"]),
      contract_version: Schema.Number,
    }),
  ),
});

export const GetUsageTool = Tool.make("get_usage", {
  description:
    "Read the same historical usage as T3 Code's Usage page, including work outside T3. Returns structured token/cost totals and optional provider/model/time breakdowns, merged across servers without counting shared sources twice. No project, thread, configured agent or account attribution is available. Input = uncachedInputTokens + cachedInputTokens (cache reads) + cacheCreationTokens (cache writes); totalTokens = input + outputTokens. reasoningTokens is already inside outputTokens; never add it again. costUsd is API-equivalent USD, not subscription spending: provider-reported cost or server custom/LiteLLM pricing. unpricedRecords contribute tokens but no cost; zero cost can mean unknown. cacheSavingsUsd estimates cache-read savings where rates exist. records are canonical deduplicated usage records, not necessarily turns. sessions counts distinct contributing native sessions per source; null for model filters or model/time groups because bucket session counts cannot be summed. Zero token fields do not prove a provider reported that metric; incomplete/unrecognized records are not estimated. Inspect sources (missing/partial/failed, skippedFiles, messages), pricing and errors for coverage; malformedRecords is currently not a complete missing-record count. Daily windows support up to 3660 calendar days; hourly windows up to 24 hours, including DST transitions. Unknown contracts are excluded and reported. Unreachable servers do not prevent other servers returning data. This tool only reads usage; it does not change settings, refresh rate tables explicitly, or run agents.",
  parameters: Parameters,
  success: Success,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Read T3 Code usage")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

type Input = typeof Parameters.Type;
const DAY_MS = 86_400_000;
const isBridgeError = Schema.is(BridgeError);

/** Reject invalid dates/zones instead of the underlying scanner's permissive UTC fallback. */
export function usageWindow(input: Input): UsageSummaryInput {
  const invalid = (message: string): never => {
    throw new BridgeError({ message });
  };
  const date = (value: string) => {
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(ms) ||
      new Date(ms).toISOString().slice(0, 10) !== value
    ) {
      return invalid(`Invalid calendar date "${value}"; use YYYY-MM-DD.`);
    }
    return ms;
  };
  const since = date(input.since_day);
  const until = date(input.until_day);
  if (since > until || (until - since) / DAY_MS >= 3660)
    invalid("Daily date range must be ordered and contain at most 3660 calendar days.");
  if (/^[+-]/.test(input.time_zone))
    invalid("time_zone must be an IANA zone, not a fixed numeric offset.");
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: input.time_zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return invalid(`Invalid IANA time_zone "${input.time_zone}".`);
  }
  const resolution = input.resolution ?? "day";
  const groups = input.group_by ?? [];
  if (
    new Set(groups).size !== groups.length ||
    (groups.includes("day") && groups.includes("hour")) ||
    (groups.includes("hour") && resolution !== "hour")
  ) {
    invalid(
      "group_by must contain unique dimensions, with at most one time dimension; hour requires hourly resolution.",
    );
  }
  const window = {
    sinceDay: UsageDay.make(input.since_day),
    untilDay: UsageDay.make(input.until_day),
    timeZone: input.time_zone,
    resolution,
  };
  if (resolution === "day") {
    if (input.since_time != null || input.until_time != null)
      invalid("since_time and until_time require hourly resolution.");
    return window;
  }
  const instant = (value: string | null | undefined) => {
    if (
      value == null ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    )
      return invalid("Hourly bounds must be ISO 8601 instants with Z or an explicit offset.");
    date(value.slice(0, 10));
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return invalid("Invalid hourly instant.");
    return ms;
  };
  const start = instant(input.since_time);
  const end = instant(input.until_time);
  if (end <= start || end - start > DAY_MS)
    invalid("Hourly range must be greater than zero and at most 24 hours.");
  if (
    format.format(new Date(start)) !== input.since_day ||
    format.format(new Date(end)) !== input.until_day
  )
    invalid("Hourly dates must match since_time and until_time in time_zone.");
  return {
    ...window,
    sinceTime: new Date(start).toISOString(),
    untilTime: new Date(end).toISOString(),
  };
}

function metrics(merged: MergedUsage, sessionsAvailable: boolean) {
  return {
    uncachedInputTokens: merged.uncachedInputTokens,
    cachedInputTokens: merged.cachedInputTokens,
    cacheCreationTokens: merged.cacheCreationTokens,
    outputTokens: merged.outputTokens,
    reasoningTokens: merged.reasoningTokens,
    totalTokens: merged.totalTokens,
    costUsd: merged.costUsd,
    cacheSavingsUsd: merged.costQuality.cacheSavingsUsd,
    records: merged.records,
    unpricedRecords: Math.round(merged.costQuality.unpricedShare * merged.records),
    sessions: sessionsAvailable ? merged.sessions : null,
  };
}

/** All accounting and physical-source ownership stays in the UI's canonical merge. */
export function usageReport(environments: readonly EnvironmentUsage[], input: Input) {
  const providers = input.providers ?? [];
  const models = input.models ?? [];
  const filtered = environments.map((environment) => ({
    ...environment,
    summary: {
      ...environment.summary,
      sources: environment.summary.sources.filter(
        (source) => providers.length === 0 || providers.includes(source.fingerprint.provider),
      ),
      buckets: environment.summary.buckets.filter(
        (bucket) =>
          (providers.length === 0 || providers.includes(bucket.provider)) &&
          (models.length === 0 || models.includes(bucket.model)),
      ),
    },
  }));
  const merge = (entries: readonly EnvironmentUsage[]) =>
    mergeUsage(entries, USAGE_CONTRACT_VERSION);
  const merged = merge(filtered);
  const dimensions = input.group_by ?? [];
  const groups = new Map<
    string,
    {
      labels: {
        provider?: UsageProviderKind;
        model?: string;
        day?: string;
        hour?: string;
      };
      entries: EnvironmentUsage[];
    }
  >();
  if (dimensions.length > 0) {
    for (const environment of filtered) {
      const cells = new Map<string, (typeof environment.summary.buckets)[number][]>();
      for (const bucket of environment.summary.buckets) {
        const labels = {
          ...(dimensions.includes("provider") ? { provider: bucket.provider } : {}),
          ...(dimensions.includes("model") ? { model: bucket.model } : {}),
          ...(dimensions.includes("day") ? { day: bucket.day } : {}),
          ...(dimensions.includes("hour") && bucket.hourStart !== undefined
            ? { hour: bucket.hourStart }
            : {}),
        };
        const key = JSON.stringify(labels);
        if (!groups.has(key)) groups.set(key, { labels, entries: [] });
        const buckets = cells.get(key) ?? [];
        buckets.push(bucket);
        cells.set(key, buckets);
      }
      for (const [key, buckets] of cells) {
        groups
          .get(key)!
          .entries.push({ ...environment, summary: { ...environment.summary, buckets } });
      }
    }
  }
  const sessionsAvailable = models.length === 0;
  const groupSessionsAvailable =
    sessionsAvailable && dimensions.every((dimension) => dimension === "provider");
  // Include every environment in each merge so an absent cell cannot transfer source ownership.
  const rows = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, group]) => {
      const entries = filtered.map((environment) => {
        const entry = group.entries.find(
          (entry) => entry.environmentId === environment.environmentId,
        );
        const sources = environment.summary.sources.filter(
          (source) =>
            group.labels.provider === undefined ||
            source.fingerprint.provider === group.labels.provider,
        );
        return {
          ...environment,
          summary: { ...environment.summary, sources, buckets: entry?.summary.buckets ?? [] },
        };
      });
      const value = merge(entries);
      return value.records === 0
        ? []
        : [{ ...group.labels, metrics: metrics(value, groupSessionsAvailable) }];
    });
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 50;
  return {
    filters: { providers, models },
    group_by: dimensions,
    totals: metrics(merged, sessionsAvailable),
    groups: rows.slice(offset, offset + limit),
    total_groups: rows.length,
    next_offset: offset + limit < rows.length ? offset + limit : null,
    duplicate_sources: merged.duplicateSources,
    contributing_servers: merged.contributingEnvironments,
    contract_mismatches: merged.contractMismatches.map((mismatch) => ({
      server_id: mismatch.environmentId,
      direction: mismatch.direction,
      contract_version: mismatch.contractVersion,
    })),
  };
}

export const getUsage = Effect.fn("getUsage")(function* (
  environments: typeof Environments.Service,
  input: Input,
) {
  const window = yield* Effect.try({
    try: () => usageWindow(input),
    catch: (error) =>
      isBridgeError(error) ? error : new BridgeError({ message: "Invalid usage query." }),
  });
  const targets =
    input.server_id == null
      ? yield* environments.enabled
      : [yield* environments.get(input.server_id)];
  const listings = yield* Effect.forEach(
    targets,
    (environment) =>
      Effect.result(environment.usageSummary(window)).pipe(
        Effect.map((summary) => ({ environment, summary })),
      ),
    { concurrency: 4 },
  );
  const entries = listings.flatMap(({ environment, summary }) =>
    Result.isSuccess(summary)
      ? [
          {
            environmentId: EnvironmentId.make(environment.id),
            label: environment.name,
            summary: summary.success,
          },
        ]
      : [],
  );
  return {
    window,
    ...usageReport(entries, input),
    servers: listings.map(({ environment, summary }) => ({
      server_id: environment.id,
      name: environment.name,
      ...(Result.isFailure(summary)
        ? { error: summary.failure.message, sources: [] }
        : {
            read_at: summary.success.readAt,
            contract_version: summary.success.contractVersion,
            sources: summary.success.sources,
            pricing: summary.success.pricing,
          }),
    })),
  };
});
