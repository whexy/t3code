import type { RexSelectOutcome } from "@t3tools/contracts/rex";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/** The client starts no select later than this after its click, so the lease still covers it. */
const CLICK_DEADLINE_MS = 10_000;
/** The whole select, launch retries included. */
const SELECT_BUDGET_MS = 10_000;
const RETRY_DELAY = "500 millis";

/** One `rex -C <this Mac> do session.select` run, as far as the lifecycle cares. */
export type SelectAttempt =
  | "ok"
  /** The app is not connected to the Mac's server, or the server is not running. */
  | "appMissing"
  /**
   * The app found no host listing the session within its 5 s wait. Rex 0.1.0 (2061) answers this
   * for a session the host just created, sometimes while already showing it.
   */
  | "notFound"
  | "error"
  /** Cut off; the app may still act on it. */
  | "timeout";

export const classifySelect = (code: number, stderr: string): SelectAttempt => {
  if (code === 0) return "ok";
  if (/client target .* not found/.test(stderr) || stderr.includes("server is not running")) {
    return "appMissing";
  }
  if (stderr.includes("SessionNotFoundOnServerError")) return "notFound";
  return "error";
};

export interface SelectDeps<E, R> {
  readonly select: (timeoutMs: number) => Effect.Effect<SelectAttempt, E, R>;
  /** Launches Rex, or brings it to the front when it runs. */
  readonly openApp: Effect.Effect<void, E, R>;
}

/**
 * Selects the session in this Mac's own Rex app. A launch counts inside the budget, and after one
 * a missing app or session is retried while the app connects to its hosts.
 */
export const selectInApp = Effect.fn("DesktopRex.selectInApp")(function* <E, R>(
  clickedAt: number,
  deps: SelectDeps<E, R>,
) {
  const start = yield* Clock.currentTimeMillis;
  if (start - clickedAt > CLICK_DEADLINE_MS) return "expired" satisfies RexSelectOutcome;
  let launched = false;
  let attempt: SelectAttempt | undefined;
  while (true) {
    const remaining = SELECT_BUDGET_MS - ((yield* Clock.currentTimeMillis) - start);
    if (remaining <= 0) {
      return (attempt === "notFound" ? "notListed" : "failed") satisfies RexSelectOutcome;
    }
    attempt = yield* deps.select(remaining);
    switch (attempt) {
      case "ok":
        // Select shows the session but leaves Rex behind other apps.
        yield* deps.openApp;
        return "selected" satisfies RexSelectOutcome;
      case "timeout":
        return "timedOut" satisfies RexSelectOutcome;
      case "error":
        return "failed" satisfies RexSelectOutcome;
      case "notFound":
        if (!launched) return "notListed" satisfies RexSelectOutcome;
        break;
      case "appMissing":
        if (!launched) {
          yield* deps.openApp;
          launched = true;
        }
        break;
    }
    yield* Effect.sleep(RETRY_DELAY);
  }
});
