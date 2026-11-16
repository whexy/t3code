import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

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

/** What the super agent writes; the server stamps `updatedAt`. */
export const SuperThreadBoardInput = Schema.Struct({
  goal: Schema.String.check(Schema.isMaxLength(4000)),
  items: Schema.Array(SuperThreadBoardItem).check(Schema.isMaxLength(SUPER_THREAD_BOARD_MAX_ITEMS)),
});
export type SuperThreadBoardInput = typeof SuperThreadBoardInput.Type;

/** Written whole by the super agent; read-only for people. */
export const SuperThreadBoard = Schema.Struct({
  ...SuperThreadBoardInput.fields,
  /** A string like the thread's other nested times, since the stored thread JSON maps only its own. */
  updatedAt: IsoDateTime,
});
export type SuperThreadBoard = typeof SuperThreadBoard.Type;

/**
 * Present only on a super thread, fixed at creation. `members` is append-only and holds only
 * threads this thread launched itself, which is what keeps every thread in at most one group.
 */
export const SuperThreadState = Schema.Struct({
  members: Schema.Array(SuperThreadMember),
  /** Absent reads as null, which lets a shell's `{ members }` stand in for a whole state. */
  board: Schema.optionalKey(Schema.NullOr(SuperThreadBoard)),
});
export type SuperThreadState = typeof SuperThreadState.Type;

/** The shell streams on every thread change, so it carries members only; the board rides on thread detail. */
export const SuperThreadShellState = Schema.Struct({
  members: SuperThreadState.fields.members,
});
export type SuperThreadShellState = typeof SuperThreadShellState.Type;

/**
 * Server-only commands. Each refuses a thread that is not a super thread, and recording a member
 * already on the list changes nothing.
 */
export const SuperThreadInternalCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("super_thread.member.record"),
    commandId: CommandId,
    threadId: ThreadId,
    member: SuperThreadMember,
  }),
  Schema.Struct({
    type: Schema.Literal("super_thread.board.set"),
    commandId: CommandId,
    threadId: ThreadId,
    board: SuperThreadBoardInput,
  }),
]);
export type SuperThreadInternalCommand = typeof SuperThreadInternalCommand.Type;
