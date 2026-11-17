// The fork's dev OTA lane: client bundles built from `dev`, served by
// ota.clusters.work on top of the released build they were checked against.
export const DEV_UPDATES_MANIFEST_URL = "https://ota.clusters.work/t3code/manifest";
export const DEV_UPDATES_CHANNEL = "dev";

export type DevUpdatesPlatform = "ios" | "desktop" | "web";

export interface DevBundle {
  readonly updateId: string;
  readonly commit: string | null;
  readonly createdAt: string;
}

export interface DevUpdatesState {
  readonly enabled: boolean;
  // The release the installed build came from, which is also its OTA runtime version.
  readonly runtimeVersion: string;
  // null while the build's own bundle runs.
  readonly running: DevBundle | null;
  // Downloaded, and takes over at the next launch or reload.
  readonly pending: DevBundle | null;
}

export interface DevUpdatesBridge {
  readonly getState: () => Promise<DevUpdatesState>;
  readonly setEnabled: (enabled: boolean) => Promise<DevUpdatesState>;
  /** Reloads every app window into the bundle the next launch would run. Absent in older desktop builds. */
  readonly reload?: () => Promise<void>;
}

// The desktop preload exposes the bridge under this global; the hub answers at this path.
export const DEV_UPDATES_DESKTOP_GLOBAL = "t3DevUpdates";
export const DEV_UPDATES_HUB_PATH = "/__t3code/dev-updates";
