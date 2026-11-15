import {
  DEV_UPDATES_CHANNEL,
  DEV_UPDATES_MANIFEST_URL,
  type DevBundle,
  type DevUpdatesState,
} from "@t3tools/shared/devUpdates";

interface LoadedUpdate {
  readonly updateId?: string;
  readonly createdAt?: Date;
  readonly manifest?: unknown;
}

export interface DevUpdatesSnapshot {
  readonly enabled: boolean;
  readonly runtimeVersion: string | null;
  readonly running: LoadedUpdate & {
    readonly isEmbeddedLaunch: boolean;
    // A launch with no launchable update in the database runs the embedded bundle without an id.
    readonly isEmergencyLaunch: boolean;
  };
  readonly downloaded: LoadedUpdate | null;
}

// A running dev bundle also counts: it launches only under the dev channel override.
export function isForkUpdatesBuild(
  configuredUpdatesUrl: string | undefined,
  launchChannel: string | null,
): boolean {
  return configuredUpdatesUrl === DEV_UPDATES_MANIFEST_URL || launchChannel === DEV_UPDATES_CHANNEL;
}

export function deriveDevUpdatesState(snapshot: DevUpdatesSnapshot): DevUpdatesState {
  const running =
    snapshot.running.isEmbeddedLaunch || snapshot.running.isEmergencyLaunch
      ? null
      : toDevBundle(snapshot.running);
  // expo-updates launches only updates fetched under the current channel, so a dev download is
  // dropped once the switch is off.
  const downloaded = snapshot.enabled ? toDevBundle(snapshot.downloaded) : null;
  return {
    enabled: snapshot.enabled,
    runtimeVersion: snapshot.runtimeVersion ?? "",
    running,
    pending: downloaded && downloaded.updateId !== running?.updateId ? downloaded : null,
  };
}

/** Whether a reload would run a different bundle than the one running now. */
export function needsReload(state: DevUpdatesState): boolean {
  return state.enabled ? state.pending !== null : state.running !== null;
}

export function shortCommit(bundle: DevBundle): string {
  return bundle.commit ? bundle.commit.slice(0, 7) : bundle.updateId.slice(0, 8);
}

function toDevBundle(update: LoadedUpdate | null): DevBundle | null {
  if (!update?.updateId || !update.createdAt) return null;
  return {
    updateId: update.updateId,
    commit: gitCommitOf(update.manifest),
    createdAt: update.createdAt.toISOString(),
  };
}

function gitCommitOf(manifest: unknown): string | null {
  if (typeof manifest !== "object" || manifest === null || !("metadata" in manifest)) return null;
  const metadata = manifest.metadata;
  if (typeof metadata !== "object" || metadata === null || !("gitCommit" in metadata)) return null;
  const commit = metadata.gitCommit;
  return typeof commit === "string" && commit.length > 0 ? commit : null;
}
