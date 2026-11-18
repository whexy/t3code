import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { classifySelect, selectInApp, type SelectAttempt } from "./select.ts";

describe("classifySelect", () => {
  it.each([
    [0, "", "ok"],
    [3, 'Error: client target "Wenxuan’s MacBook Air" not found\n', "appMissing"],
    [
      1,
      "Error: rex server is not running\nconnecting to Rex server unix:///x: ...\n",
      "appMissing",
    ],
    [
      1,
      "Error: The operation couldn’t be completed. ((extension in RexMacOS):RexShared.Workspace.(unknown context at $104309de8).SessionNotFoundOnServerError error 1.)\n",
      "notFound",
    ],
    [1, "Error: something else\n", "error"],
  ] as const)("exit %i with %j is %s", (code, stderr, expected) => {
    assert.strictEqual(classifySelect(code, stderr), expected);
  });
});

/** Answers each select with the next scripted attempt and counts what the flow did. */
const script = (attempts: ReadonlyArray<SelectAttempt>) => {
  const calls = { select: 0, openApp: 0 };
  return {
    calls,
    deps: {
      select: () => Effect.sync(() => attempts[Math.min(calls.select++, attempts.length - 1)]!),
      openApp: Effect.sync(() => {
        calls.openApp++;
      }),
    },
  };
};

const runFor = <A>(effect: Effect.Effect<A>, elapsed: Duration.Input) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust(elapsed);
    return yield* Fiber.join(fiber);
  });

describe("selectInApp", () => {
  it.effect("selects, then brings Rex to the front", () =>
    Effect.gen(function* () {
      const { calls, deps } = script(["ok"]);
      assert.strictEqual(yield* selectInApp(0, deps), "selected");
      assert.deepStrictEqual(calls, { select: 1, openApp: 1 });
    }),
  );

  it.effect("launches a missing app once and retries until the session shows up", () =>
    Effect.gen(function* () {
      const { calls, deps } = script(["appMissing", "appMissing", "notFound", "ok"]);
      assert.strictEqual(yield* runFor(selectInApp(0, deps), "2 seconds"), "selected");
      assert.deepStrictEqual(calls, { select: 4, openApp: 2 });
    }),
  );

  it.effect("a session no host has fails at once when the app was already running", () =>
    Effect.gen(function* () {
      const { calls, deps } = script(["notFound"]);
      assert.strictEqual(yield* selectInApp(0, deps), "failed");
      assert.deepStrictEqual(calls, { select: 1, openApp: 0 });
    }),
  );

  it.effect("a select cut off by its timeout reports nothing", () =>
    Effect.gen(function* () {
      const { deps } = script(["timeout"]);
      assert.strictEqual(yield* selectInApp(0, deps), "timedOut");
    }),
  );

  it.effect("an app that never connects fails once the budget is spent", () =>
    Effect.gen(function* () {
      const { calls, deps } = script(["appMissing"]);
      assert.strictEqual(yield* runFor(selectInApp(0, deps), "11 seconds"), "failed");
      assert.strictEqual(calls.openApp, 1);
    }),
  );

  it.effect("a click older than its deadline abandons without selecting", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("10001 millis");
      const { calls, deps } = script(["ok"]);
      assert.strictEqual(yield* selectInApp(0, deps), "expired");
      assert.strictEqual(calls.select, 0);
    }),
  );
});
