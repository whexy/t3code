import type { RelayAgentAwarenessPhase } from "@t3tools/contracts/relay";

/** Bundled by apps/mobile's expo-notifications `sounds`; iOS plays the default sound when a build lacks it. */
export const COMPLETION_ALERT_SOUND = "notification-completion.wav";

/** Completions chime as on web; asks and failures keep the system sound so they stay distinct. */
export function alertSound(phases: ReadonlyArray<RelayAgentAwarenessPhase | undefined>): string {
  return phases.length > 0 && phases.every((phase) => phase === "completed")
    ? COMPLETION_ALERT_SOUND
    : "default";
}
