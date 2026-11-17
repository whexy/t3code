import type { PullRequestSummary } from "@t3tools/contracts";

export interface PullRequestWatchStart {
  readonly next?: string;
}

// A new watch records checks that already finished without reporting them, so the agent must
// hear about them here or it waits for a wake that never comes. The MCP handler words passing.
const NEXT = {
  failing:
    "Checks on this pull request already failed. T3 Code does not wake you for checks that finished before the watch started, so act on them now as your task requires. After you push a fix, the watch wakes you on its checks.",
  unknown:
    "T3 Code could not read this pull request's checks. If they already finished, no wake comes for them, so check them yourself before you end your turn.",
};

/** `summary` is null when the read failed. */
export const pullRequestWatchStartResult = (
  summary: Pick<PullRequestSummary, "checksState"> | null,
): PullRequestWatchStart => {
  if (summary === null) return { next: NEXT.unknown };
  return summary.checksState === "failing" ? { next: NEXT.failing } : {};
};
