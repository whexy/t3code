import type { DevBundle, DevUpdatesState } from "@t3tools/shared/devUpdates";

import type { DevUpdatesBackendKind } from "~/state/devUpdates";

export interface DevUpdatesView {
  readonly description: string;
  readonly offerReload: boolean;
}

const devLabel = (bundle: DevBundle) =>
  `dev ${bundle.commit?.slice(0, 7) ?? bundle.updateId.slice(0, 8)}`;

/**
 * `enabledBeforeChange` is the switch's value before this page first changed it,
 * or null while it has not. The hub picks a bundle per page load, so only a
 * change made since then calls for a reload.
 */
export function describeDevUpdates(input: {
  readonly kind: DevUpdatesBackendKind;
  readonly state: DevUpdatesState;
  readonly enabledBeforeChange: boolean | null;
}): DevUpdatesView {
  const { state } = input;
  const release = `release ${state.runtimeVersion}`;
  const turnOn = "Turn on to get each build from dev.";

  if (input.kind === "hub") {
    const serving = !state.enabled
      ? `This browser gets ${release}. ${turnOn}`
      : state.running
        ? `This browser gets ${devLabel(state.running)}, built for ${release}.`
        : `No dev build for ${release} yet, so this browser gets the release.`;
    const changed =
      input.enabledBeforeChange !== null && input.enabledBeforeChange !== state.enabled;
    return {
      description: changed ? `${serving} Reload to apply.` : serving,
      offerReload: changed,
    };
  }

  const running = state.running
    ? `Running ${devLabel(state.running)} on ${release}.`
    : `Running ${release}.`;
  const next = !state.enabled
    ? state.running
      ? `The next launch runs ${release}.`
      : turnOn
    : state.pending
      ? `The next launch runs ${devLabel(state.pending)}.`
      : state.running
        ? null
        : "Dev builds download in the background and apply at the next launch.";
  return {
    description: next === null ? running : `${running} ${next}`,
    offerReload: state.enabled ? state.pending !== null : state.running !== null,
  };
}
