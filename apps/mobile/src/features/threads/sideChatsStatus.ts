import { resolveThreadListV2Status } from "./threadListV2";

/** Side chats waiting on the user, for a menu that hides them until it opens. */
export function describeSideChatsAwaitingUser(
  sideChats: ReadonlyArray<Parameters<typeof resolveThreadListV2Status>[0]>,
): string | null {
  let approvals = 0;
  let inputs = 0;
  for (const sideChat of sideChats) {
    const status = resolveThreadListV2Status(sideChat);
    if (status === "approval") approvals += 1;
    else if (status === "input") inputs += 1;
  }
  const count = (n: number, what: string) =>
    `${n} side chat${n === 1 ? " needs" : "s need"} ${what}`;
  const parts = [
    approvals > 0 ? count(approvals, "approval") : null,
    inputs > 0 ? count(inputs, "input") : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}
