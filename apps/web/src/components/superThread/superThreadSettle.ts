import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { buildSuperThreadSettleConfirmation } from "@t3tools/client-runtime/state/super-thread-presentation";
import { planSuperThreadSettle } from "@t3tools/client-runtime/state/super-threads";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell, readThreadShells } from "../../state/entities";
import { environmentSummaries } from "../../state/presentation";
import { toastManager } from "../ui/toast";

type SettleOne = (
  ref: ScopedThreadRef,
) => Promise<{ readonly _tag: "Success" | "Failure" | "Initial" }>;

export interface SuperThreadSettle {
  /** Settles the members once the header has settled. */
  readonly settleMembers: (settleOne: SettleOne) => Promise<void>;
}

/**
 * Settling a super thread settles the members it launched too. Returns null for any other
 * thread, and "cancelled" when the person declines the confirmation.
 */
export async function confirmSuperThreadSettle(
  shell: EnvironmentThreadShell | null | undefined,
): Promise<SuperThreadSettle | "cancelled" | null> {
  if (shell?.source?.superThread === undefined) return null;
  const headerKey = scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id));
  const plan = planSuperThreadSettle(
    shell,
    readThreadShells(),
    new Set(appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom)),
  );
  const members = plan.settles.filter((ref) => scopedThreadKey(ref) !== headerKey);
  const message = buildSuperThreadSettleConfirmation({
    title: shell.title,
    warnings: plan.warnings,
    memberSettleCount: members.length,
    titleOf: (ref) => readThreadShell(ref)?.title ?? null,
  });
  if (message !== null) {
    const confirmed = (await readLocalApi()?.dialogs.confirm(message)) ?? true;
    if (!confirmed) return "cancelled";
  }
  return {
    settleMembers: async (settleOne) => {
      const results = await Promise.all(
        members.map((member) => settleOne(member).catch(() => null)),
      );
      const kept = results.filter((result) => result?._tag !== "Success").length;
      if (kept > 0) {
        toastManager.add({
          type: "info",
          title: `${kept} thread${kept === 1 ? "" : "s"} stayed open`,
          description: "They are still working or could not be settled.",
        });
      }
    },
  };
}
