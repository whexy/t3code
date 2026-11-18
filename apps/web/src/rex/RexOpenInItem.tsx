import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import {
  REX_DESKTOP_GLOBAL,
  type RexDesktopBridge,
  type RexSelectOutcome,
} from "@t3tools/contracts/rex";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { SquareTerminalIcon } from "lucide-react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { MenuItem, MenuItemLabel } from "../components/ui/menu";
import { toastManager } from "../components/ui/toast";
import { MAC_SIDE_FAILURE, reportFor, rexEntry } from "./rexEntry.logic";

declare global {
  interface Window {
    [REX_DESKTOP_GLOBAL]?: RexDesktopBridge;
  }
}

const rexStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:rex:status",
  tag: WS_METHODS.rexStatus,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});
const rexOpen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:rex:open",
  tag: WS_METHODS.rexOpen,
});
const rexReport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:rex:report",
  tag: WS_METHODS.rexReport,
});

// Probed once per page, like the desktop's installed editors.
const macRexAtom = Atom.make((get): boolean | null | undefined => {
  const bridge = window[REX_DESKTOP_GLOBAL];
  if (bridge === undefined) return null;
  bridge.available().then(
    (available) => get.setSelf(available),
    () => get.setSelf(false),
  );
  return undefined;
}).pipe(Atom.keepAlive, Atom.withLabel("rex-mac-available"));

export function RexOpenInItem({
  environmentId,
  cwd,
  density,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
  density: "default" | "touch";
}) {
  const macRex = useAtomValue(macRexAtom);
  const host = useEnvironmentQuery(
    macRex === false || macRex === undefined ? null : rexStatus({ environmentId, input: {} }),
  ).data;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const open = useAtomCommand(rexOpen, { reportFailure: false });
  const report = useAtomCommand(rexReport, { reportFailure: false });

  const entry = rexEntry({ macRex, host: host ?? undefined });
  if (entry.kind === "hidden" || cwd === null) return null;

  const openInRex = async (bridge: RexDesktopBridge) => {
    const clickedAt = Date.now();
    const opened = await open({ environmentId, input: { cwd } });
    if (opened._tag === "Failure") {
      const error = Option.getOrNull(Cause.findErrorOption(opened.cause));
      toastManager.add({
        type: "error",
        title: MAC_SIDE_FAILURE,
        ...(error === null ? {} : { description: error.message }),
      });
      return;
    }
    const { clickId, sessionId } = opened.value;
    const outcome = await bridge
      .select({ sessionId, clickedAt })
      .catch((): RexSelectOutcome => "failed");
    const outcomeReport = reportFor(outcome);
    if (outcomeReport !== null) {
      void report({ environmentId, input: { cwd, clickId, sessionId, outcome: outcomeReport } });
    }
    if (outcome !== "selected") toastManager.add({ type: "error", title: MAC_SIDE_FAILURE });
  };

  return (
    <MenuItem
      density={density}
      disabled={entry.kind === "disabled" || !canOperate}
      onClick={() => {
        const bridge = window[REX_DESKTOP_GLOBAL];
        if (bridge !== undefined) void openInRex(bridge);
      }}
    >
      <SquareTerminalIcon aria-hidden="true" className="text-muted-foreground" />
      <MenuItemLabel>{entry.kind === "disabled" ? `Rex: ${entry.reason}` : "Rex"}</MenuItemLabel>
    </MenuItem>
  );
}
