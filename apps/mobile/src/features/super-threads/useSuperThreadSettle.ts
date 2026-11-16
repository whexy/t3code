import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { buildSuperThreadSettleConfirmation } from "@t3tools/client-runtime/state/super-thread-presentation";
import { planSuperThreadSettle } from "@t3tools/client-runtime/state/super-threads";

import * as Dialog from "../../components/ui/Dialog";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export interface SuperThreadSettle {
  /** Settles the members once the header has settled. */
  readonly settleMembers: () => void;
}

function confirmSettle(message: string, stopsWork: boolean): Promise<boolean> {
  const [title = message, ...detail] = message.split("\n");
  return new Promise((resolve) =>
    Dialog.confirm({
      title,
      message: detail.join("\n\n"),
      confirmText: "Settle",
      destructive: stopsWork,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    }),
  );
}

/**
 * Settling a super thread settles the members it launched too, asking first when any is busy
 * or out of reach. Resolves null for any other thread, and "cancelled" when the person declines.
 */
export function useSuperThreadSettle() {
  const settle = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  return async (
    thread: EnvironmentThreadShell,
  ): Promise<SuperThreadSettle | "cancelled" | null> => {
    if (thread.source.superThread === undefined) return null;
    const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
    const plan = planSuperThreadSettle(
      thread,
      shells,
      new Set(appAtomRegistry.get(connectedEnvironmentIdsAtom)),
    );
    const headerKey = scopedThreadKey(thread.environmentId, thread.id);
    const members = plan.settles.filter(
      (ref) => scopedThreadKey(ref.environmentId, ref.threadId) !== headerKey,
    );
    const titleByKey = new Map(
      shells.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell.title]),
    );
    const message = buildSuperThreadSettleConfirmation({
      title: thread.title,
      warnings: plan.warnings,
      memberSettleCount: members.length,
      titleOf: (ref) => titleByKey.get(scopedThreadKey(ref.environmentId, ref.threadId)) ?? null,
    });
    const stopsWork = plan.warnings.some((warning) => warning.reason === "running");
    if (message !== null && !(await confirmSettle(message, stopsWork))) return "cancelled";
    return {
      // A member the server refuses, such as one still working, stays and keeps the section.
      settleMembers: () => {
        for (const member of members) {
          void settle({
            environmentId: member.environmentId,
            input: { threadId: member.threadId },
          });
        }
      },
    };
  };
}
