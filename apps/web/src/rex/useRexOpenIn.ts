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

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../components/ui/toast";
import {
  MAC_SIDE_FAILURE,
  NOT_LISTED_YET,
  reportFor,
  rexEntry,
  type RexEntry,
} from "./rexEntry.logic";
import { useRexPreferred } from "./rexPreference";

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

export interface RexOpenIn {
  readonly entry: RexEntry;
  /** Rex was chosen on this device; it leads the picker only while the entry is enabled. */
  readonly preferred: boolean;
  readonly setPreferred: (preferred: boolean) => void;
  readonly open: () => Promise<boolean>;
}

/** `cwd` is the folder to open, or null when the picker targets a file. */
export function useRexOpenIn(environmentId: EnvironmentId, cwd: string | null): RexOpenIn {
  const macRex = useAtomValue(macRexAtom);
  const host = useEnvironmentQuery(
    macRex === false || macRex === undefined || cwd === null
      ? null
      : rexStatus({ environmentId, input: {} }),
  ).data;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [preferred, setPreferred] = useRexPreferred();
  const runOpen = useAtomCommand(rexOpen, { reportFailure: false });
  const report = useAtomCommand(rexReport, { reportFailure: false });

  const entry: RexEntry =
    cwd === null ? { kind: "hidden" } : rexEntry({ macRex, host: host ?? undefined, canOperate });

  const open = async (): Promise<boolean> => {
    const bridge = window[REX_DESKTOP_GLOBAL];
    if (bridge === undefined || cwd === null || entry.kind !== "enabled") return false;
    const clickedAt = Date.now();
    const opened = await runOpen({ environmentId, input: { cwd } });
    if (opened._tag === "Failure") {
      const error = Option.getOrNull(Cause.findErrorOption(opened.cause));
      toastManager.add({
        type: "error",
        title: MAC_SIDE_FAILURE,
        ...(error === null ? {} : { description: error.message }),
      });
      return false;
    }
    const { clickId, sessionId } = opened.value;
    const outcome = await bridge
      .select({ sessionId, clickedAt })
      .catch((): RexSelectOutcome => "failed");
    const outcomeReport = reportFor(outcome);
    if (outcomeReport !== null) {
      void report({ environmentId, input: { cwd, clickId, sessionId, outcome: outcomeReport } });
    }
    if (outcome !== "selected") {
      toastManager.add({
        type: "error",
        title: MAC_SIDE_FAILURE,
        ...(outcome === "notListed" ? { description: NOT_LISTED_YET } : {}),
      });
    }
    return outcome === "selected";
  };

  return { entry, preferred, setPreferred, open };
}
