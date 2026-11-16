import type { EnvironmentId, RunId, ScopedThreadRef } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";
import { toSortableTimestamp } from "./threadSort.ts";

export interface SuperThreadSection<T extends EnvironmentThreadShell> {
  readonly header: T;
  readonly rows: ReadonlyArray<T>;
}

export interface SuperThreadSections<T extends EnvironmentThreadShell> {
  readonly sections: ReadonlyArray<SuperThreadSection<T>>;
  /** Threads the normal sidebar sections leave out because a super thread section shows them. */
  readonly claimedThreadKeys: ReadonlySet<string>;
}

export interface SuperThreadSettleWarning {
  readonly ref: ScopedThreadRef;
  readonly reason: "running" | "needs-input" | "unreachable";
}

export interface SuperThreadSettle {
  readonly ref: ScopedThreadRef;
  /** Sent as `thread.settle`'s `expectedLatestRunId`, so work started after confirming refuses. */
  readonly expectedLatestRunId: RunId | null;
}

export interface SuperThreadSettlePlan {
  readonly warnings: ReadonlyArray<SuperThreadSettleWarning>;
  readonly settles: ReadonlyArray<SuperThreadSettle>;
}

const shellKey = (shell: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id));

// The sidebar's own definition: only an explicit settle puts a thread on the Settled shelf.
const isSettled = (shell: EnvironmentThreadShell) => shell.settledOverride === "settled";

const isGone = (shell: EnvironmentThreadShell) =>
  shell.archivedAt !== null || shell.deletedAt !== null;

function needsInput(shell: EnvironmentThreadShell): boolean {
  return (
    shell.hasPendingApprovals ||
    shell.hasPendingUserInput ||
    shell.pendingSubagentRequest != null ||
    (shell.pendingGuestMessageCount ?? 0) > 0
  );
}

/** Needing the person first, then done, then working. */
function rowRank(shell: EnvironmentThreadShell): number {
  if (needsInput(shell) || shell.runtime?.status === "failed") return 0;
  return isThreadWorking(shell) ? 2 : 1;
}

function latestActivity(shell: EnvironmentThreadShell): number {
  return Math.max(
    toSortableTimestamp(shell.createdAt) ?? 0,
    toSortableTimestamp(shell.unsettledAt ?? undefined) ?? 0,
    toSortableTimestamp(shell.latestRun?.requestedAt ?? undefined) ?? 0,
    toSortableTimestamp(shell.latestRun?.completedAt ?? undefined) ?? 0,
  );
}

function compareNewestThenKey(
  left: { readonly activity: number; readonly key: string },
  right: { readonly activity: number; readonly key: string },
): number {
  if (left.activity !== right.activity) return right.activity - left.activity;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/**
 * Sections for every super thread the client holds. Members whose shell is not held are absent.
 * A thread listed by two super threads cannot happen by design; if it does, the oldest super
 * thread (then lowest key) claims it so the result does not depend on input order.
 */
export function deriveSuperThreadSections<T extends EnvironmentThreadShell>(
  shells: ReadonlyArray<T>,
): SuperThreadSections<T> {
  const byKey = new Map(shells.map((shell) => [shellKey(shell), shell] as const));
  const headers = shells
    .filter((shell) => shell.source.superThread !== undefined && !isGone(shell))
    .map((shell) => ({
      shell,
      key: shellKey(shell),
      // Negated so the newest-first comparator orders oldest first.
      activity: -(toSortableTimestamp(shell.createdAt) ?? 0),
    }))
    .sort(compareNewestThenKey);
  const headerKeys = new Set(headers.map((header) => header.key));
  const claimed = new Set<string>();
  const shown: Array<{ section: SuperThreadSection<T>; activity: number; key: string }> = [];

  for (const header of headers) {
    const rows: Array<{ shell: T; rank: number; activity: number; key: string }> = [];
    for (const member of header.shell.source.superThread?.members ?? []) {
      const key = scopedThreadKey(scopeThreadRef(member.environmentId, member.threadId));
      const shell = byKey.get(key);
      if (shell === undefined || isGone(shell) || isSettled(shell)) continue;
      if (claimed.has(key) || headerKeys.has(key)) continue;
      claimed.add(key);
      rows.push({ shell, rank: rowRank(shell), activity: latestActivity(shell), key });
    }
    if (rows.length === 0 && isSettled(header.shell)) continue;
    claimed.add(header.key);
    rows.sort((left, right) => left.rank - right.rank || compareNewestThenKey(left, right));
    shown.push({
      section: { header: header.shell, rows: rows.map((row) => row.shell) },
      activity: Math.max(latestActivity(header.shell), ...rows.map((row) => row.activity)),
      key: header.key,
    });
  }

  shown.sort(compareNewestThenKey);
  return { sections: shown.map((entry) => entry.section), claimedThreadKeys: claimed };
}

/**
 * What settling a super thread does: settle the header and every held, unsettled member, each
 * guarded by the latest run the client saw. Members that are busy or out of reach are listed
 * for confirmation; unreachable ones are not settled.
 */
export function planSuperThreadSettle(
  superShell: EnvironmentThreadShell,
  shells: ReadonlyArray<EnvironmentThreadShell>,
  reachableEnvironmentIds: ReadonlySet<EnvironmentId>,
): SuperThreadSettlePlan {
  const byKey = new Map(shells.map((shell) => [shellKey(shell), shell] as const));
  const warnings: SuperThreadSettleWarning[] = [];
  const settles: SuperThreadSettle[] = [];
  const settle = (shell: EnvironmentThreadShell) =>
    settles.push({
      ref: scopeThreadRef(shell.environmentId, shell.id),
      expectedLatestRunId: shell.latestRun?.runId ?? null,
    });

  if (!isSettled(superShell)) settle(superShell);
  const seen = new Set<string>([shellKey(superShell)]);
  for (const member of superShell.source.superThread?.members ?? []) {
    const ref = scopeThreadRef(member.environmentId, member.threadId);
    const key = scopedThreadKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const shell = byKey.get(key);
    if (shell !== undefined && (isGone(shell) || isSettled(shell))) continue;
    if (shell === undefined || !reachableEnvironmentIds.has(member.environmentId)) {
      warnings.push({ ref, reason: "unreachable" });
      continue;
    }
    if (needsInput(shell)) warnings.push({ ref, reason: "needs-input" });
    else if (isThreadWorking(shell)) warnings.push({ ref, reason: "running" });
    settle(shell);
  }
  return { warnings, settles };
}
