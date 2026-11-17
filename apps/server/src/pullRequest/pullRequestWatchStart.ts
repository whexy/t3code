import { PullRequestChecksState, type PullRequestSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Result fields `watch_pull_request` adds when it starts a watch. */
export const PullRequestWatchStartFields = {
  checks: Schema.optional(
    Schema.Union([PullRequestChecksState, Schema.Literal("unknown")]).annotate({
      description: "The checks when the watch started; unknown when the host could not be read.",
    }),
  ),
  next: Schema.optional(Schema.String),
};

type WatchStartChecks = PullRequestChecksState | "unknown";

export interface PullRequestWatchStart {
  readonly checks?: WatchStartChecks;
  readonly next?: string;
}

// A new watch records checks that already finished without reporting them, so the agent must
// hear about them here or it waits for a wake that never comes.
const NEXT: Partial<Record<WatchStartChecks, string>> = {
  passing:
    "Checks on this pull request already passed. T3 Code does not wake you for checks that finished before the watch started, so act on them now as your task requires instead of waiting.",
  failing:
    "Checks on this pull request already failed. T3 Code does not wake you for checks that finished before the watch started, so act on them now as your task requires. After you push a fix, the watch wakes you on its checks.",
  unknown:
    "T3 Code could not read this pull request's checks. If they already finished, no wake comes for them, so check them yourself before you end your turn.",
};

/** `summary` is null when the read failed. */
export const pullRequestWatchStartResult = (
  summary: Pick<PullRequestSummary, "checksState"> | null,
): PullRequestWatchStart => {
  const checks = summary === null ? "unknown" : (summary.checksState ?? undefined);
  if (checks === undefined) return {};
  const next = NEXT[checks];
  return next === undefined ? { checks } : { checks, next };
};
