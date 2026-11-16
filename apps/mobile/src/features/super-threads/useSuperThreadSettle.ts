import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { buildSuperThreadSettleConfirmation } from "@t3tools/client-runtime/state/super-thread-presentation";
import { planSuperThreadSettle } from "@t3tools/client-runtime/state/super-threads";
import type { RunId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export interface SuperThreadSettle {
  /** Guards the header's own settle with the run the confirmation showed. */
  readonly expectedLatestRunId: RunId | undefined;
  /** Settles the members once the header has settled. */
  readonly settleMembers: () => void;
}

function confirmSettle(message: string): Promise<boolean> {
  const [title = message, ...detail] = message.split("\n");
  return new Promise((resolve) =>
    Dialog.confirm({
      title,
      message: detail.join("\n\n"),
      confirmText: "Settle",
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
    const isHeader = (entry: (typeof plan.settles)[number]) =>
      scopedThreadKey(entry.ref.environmentId, entry.ref.threadId) === headerKey;
    const members = plan.settles.filter((entry) => !isHeader(entry));
    const titleByKey = new Map(
      shells.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell.title]),
    );
    const message = buildSuperThreadSettleConfirmation({
      title: thread.title,
      warnings: plan.warnings,
      memberSettleCount: members.length,
      titleOf: (ref) => titleByKey.get(scopedThreadKey(ref.environmentId, ref.threadId)) ?? null,
    });
    if (message !== null && !(await confirmSettle(message))) return "cancelled";
    return {
      expectedLatestRunId: plan.settles.find(isHeader)?.expectedLatestRunId ?? undefined,
      // A member that started new work since the confirmation refuses and keeps the section.
      settleMembers: () => {
        for (const member of members) {
          void settle({
            environmentId: member.ref.environmentId,
            input: {
              threadId: member.ref.threadId,
              expectedLatestRunId: member.expectedLatestRunId ?? undefined,
            },
          });
        }
      },
    };
  };
}
