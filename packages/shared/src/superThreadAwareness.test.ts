import { describe, expect, it } from "@effect/vitest";
import { RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  type SuperThreadMemberActivity,
  superThreadMembersHoldCompletion,
} from "./superThreadAwareness.ts";

const member = (
  status: SuperThreadMemberActivity["status"],
  request: "command" | "auth_refresh" | null = null,
  pendingBackgroundTasks: SuperThreadMemberActivity["pendingBackgroundTasks"] = [],
): SuperThreadMemberActivity => ({
  status,
  activityRunStatus: null,
  pendingBackgroundTasks,
  pendingRuntimeRequest:
    request === null
      ? null
      : {
          id: RuntimeRequestId.make(`request:${request}`),
          kind: request,
          createdAt: DateTime.makeUnsafe("2026-11-17T12:00:00.000Z"),
        },
});

describe("superThreadMembersHoldCompletion", () => {
  it.each([
    ["no members", [], false, false],
    ["a member still running", [member("completed"), member("running")], false, true],
    ["a member with queued work", [member("queued")], false, true],
    ["every member finished or failed", [member("completed"), member("failed")], false, false],
    [
      "a finished turn awaiting its background command",
      [member("completed", null, [{ taskId: "sleep", kind: "command", awaited: true }])],
      false,
      true,
    ],
    [
      "a finished turn leaving only a dev server running",
      [member("completed", null, [{ taskId: "dev", kind: "command" }])],
      false,
      false,
    ],
    ["a run followed in a linked environment", [member("completed")], true, true],
    [
      "a member waiting on the user",
      [member("running"), member("running", "command")],
      true,
      false,
    ],
    ["a member only refreshing its sign-in", [member("running", "auth_refresh")], false, true],
  ] as const)("%s", (_name, members, followingElsewhere, held) => {
    expect(superThreadMembersHoldCompletion(members, followingElsewhere)).toBe(held);
  });
});
