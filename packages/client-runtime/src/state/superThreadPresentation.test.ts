import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "../environment/scoped.ts";
import { buildSuperThreadSettleConfirmation } from "./superThreadPresentation.ts";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");

describe("buildSuperThreadSettleConfirmation", () => {
  const ref = (id: string, environmentId = local) =>
    scopeThreadRef(environmentId, ThreadId.make(id));
  const titles: Record<string, string> = { a: "Fix API", b: "Ship docs" };

  it("skips the confirmation when nothing is busy or out of reach", () => {
    expect(
      buildSuperThreadSettleConfirmation({
        title: "Release",
        warnings: [],
        memberSettleCount: 2,
        titleOf: () => null,
      }),
    ).toBeNull();
  });

  it("names busy members, warns that questions can be dismissed, and counts unreachable ones", () => {
    expect(
      buildSuperThreadSettleConfirmation({
        title: "Release",
        warnings: [
          { ref: ref("a"), reason: "running" },
          { ref: ref("b"), reason: "needs-input" },
          { ref: ref("c", remote), reason: "unreachable" },
        ],
        memberSettleCount: 2,
        titleOf: (target) => titles[target.threadId] ?? null,
      }),
    ).toBe(
      [
        'Settle "Release" and 2 threads it launched?',
        'Still running: "Fix API". Settling stops it.',
        'Waiting for you: "Ship docs". Settling can dismiss their open questions.',
        "1 thread can't be reached right now and won't be settled.",
      ].join("\n"),
    );
  });
});
