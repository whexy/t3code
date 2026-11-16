import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const SUPER_THREAD_BOARD_MAX_ITEMS = 50;

/** A thread the super thread launched, possibly in a linked environment. */
export const SuperThreadMember = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type SuperThreadMember = typeof SuperThreadMember.Type;

export const SuperThreadBoardItemStatus = Schema.Literals(["todo", "doing", "blocked", "done"]);
export type SuperThreadBoardItemStatus = typeof SuperThreadBoardItemStatus.Type;

export const SuperThreadBoardItem = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  status: SuperThreadBoardItemStatus,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  members: Schema.optional(Schema.Array(SuperThreadMember)),
});
export type SuperThreadBoardItem = typeof SuperThreadBoardItem.Type;

/** Written whole by the super agent; read-only for people. */
export const SuperThreadBoard = Schema.Struct({
  goal: Schema.String.check(Schema.isMaxLength(4000)),
  items: Schema.Array(SuperThreadBoardItem).check(Schema.isMaxLength(SUPER_THREAD_BOARD_MAX_ITEMS)),
  updatedAt: Schema.DateTimeUtc,
});
export type SuperThreadBoard = typeof SuperThreadBoard.Type;

/**
 * Present only on a super thread, fixed at creation. `members` is append-only and holds only
 * threads this thread launched itself, which is what keeps every thread in at most one group.
 */
export const SuperThreadState = Schema.Struct({
  members: Schema.Array(SuperThreadMember),
  board: Schema.NullOr(SuperThreadBoard),
});
export type SuperThreadState = typeof SuperThreadState.Type;
