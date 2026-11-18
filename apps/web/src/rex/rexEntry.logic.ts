import type { RexSelectOutcome, RexStatus } from "@t3tools/contracts/rex";

export type RexEntry =
  | { readonly kind: "hidden" }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "enabled" };

export const OPEN_FROM_DESKTOP = "Open from the T3 desktop app";
export const MAC_SIDE_FAILURE = "Couldn't open in Rex";
export const NO_OPERATE_SCOPE = "This connection can't open Rex here";

/**
 * `macRex` is null outside the desktop app, and undefined while the desktop is still looking for
 * Rex; `host` is undefined until the host answers.
 */
export function rexEntry(input: {
  readonly macRex: boolean | null | undefined;
  readonly host: RexStatus | undefined;
  readonly canOperate: boolean;
}): RexEntry {
  // As for an editor that isn't installed; an unanswered host shows nothing rather than a guess.
  if (input.macRex === false || input.macRex === undefined || input.host === undefined) {
    return { kind: "hidden" };
  }
  if (!input.host.available) return { kind: "disabled", reason: input.host.reason };
  if (input.macRex === null) return { kind: "disabled", reason: OPEN_FROM_DESKTOP };
  if (!input.canOperate) return { kind: "disabled", reason: NO_OPERATE_SCOPE };
  return { kind: "enabled" };
}

/**
 * Rex leads the picker only where it can open now; elsewhere the preferred editor does, as when
 * a preferred editor is missing. The choice itself is kept for the next environment.
 */
export const rexLeads = (rex: { readonly preferred: boolean; readonly entry: RexEntry }) =>
  rex.preferred && rex.entry.kind === "enabled";

/** What the client tells the host after the Mac's select; a timed-out select is left to the lease. */
export const reportFor = (outcome: RexSelectOutcome): "confirm" | "abandon" | null =>
  outcome === "selected" ? "confirm" : outcome === "timedOut" ? null : "abandon";
