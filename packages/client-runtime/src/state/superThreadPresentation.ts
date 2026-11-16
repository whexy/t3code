import type {
  ScopedThreadRef,
  SuperThreadBoardItem,
  SuperThreadBoardItemStatus,
} from "@t3tools/contracts";

import type { SuperThreadSettleWarning } from "./superThreads.ts";

export const SUPER_THREAD_BOARD_COLUMNS: ReadonlyArray<{
  readonly status: SuperThreadBoardItemStatus;
  readonly label: string;
}> = [
  { status: "todo", label: "To do" },
  { status: "doing", label: "Doing" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

export function groupSuperThreadBoardItems(
  items: ReadonlyArray<SuperThreadBoardItem>,
): Record<SuperThreadBoardItemStatus, ReadonlyArray<SuperThreadBoardItem>> {
  const columns: Record<SuperThreadBoardItemStatus, SuperThreadBoardItem[]> = {
    todo: [],
    doing: [],
    blocked: [],
    done: [],
  };
  for (const item of items) columns[item.status].push(item);
  return columns;
}

const LISTED_TITLES = 5;

function titleList(titles: ReadonlyArray<string>): string {
  const shown = titles.slice(0, LISTED_TITLES).map((title) => `"${title}"`);
  const rest = titles.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** The confirmation for settling a super thread, or null when nothing needs the person's attention. */
export function buildSuperThreadSettleConfirmation(input: {
  readonly title: string;
  readonly warnings: ReadonlyArray<SuperThreadSettleWarning>;
  readonly memberSettleCount: number;
  readonly titleOf: (ref: ScopedThreadRef) => string | null;
}): string | null {
  if (input.warnings.length === 0) return null;
  const titlesFor = (reason: SuperThreadSettleWarning["reason"]) =>
    input.warnings
      .filter((warning) => warning.reason === reason)
      .map((warning) => input.titleOf(warning.ref) ?? "Untitled thread");
  const running = titlesFor("running");
  const needsInput = titlesFor("needs-input");
  const unreachable = input.warnings.filter((warning) => warning.reason === "unreachable").length;
  const threads = (count: number) => `${count} thread${count === 1 ? "" : "s"}`;
  const lines = [
    input.memberSettleCount > 0
      ? `Settle "${input.title}" and ${threads(input.memberSettleCount)} it launched?`
      : `Settle "${input.title}"?`,
  ];
  if (running.length > 0) {
    lines.push(
      `Still running: ${titleList(running)}. Settling stops ${running.length === 1 ? "it" : "them"}.`,
    );
  }
  if (needsInput.length > 0) {
    lines.push(
      `Waiting for you: ${titleList(needsInput)}. Settling can dismiss their open questions.`,
    );
  }
  if (unreachable > 0) {
    lines.push(`${threads(unreachable)} can't be reached right now and won't be settled.`);
  }
  return lines.join("\n");
}
