import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { DEV_UPDATES_CHANNEL } from "@t3tools/shared/devUpdates";

import { defaultFlushPendingWrites, isAppUpdateCheckAvailable } from "./app-updates";
import { isForkUpdatesBuild } from "./dev-updates.logic";

// expo-updates stores the header override in UserDefaults and applies it before every later
// launch picks a bundle, so the channel this launch used is the persisted choice.
let devChannelSelected = Updates.channel === DEV_UPDATES_CHANNEL;

export function isDevUpdatesSupported(): boolean {
  return (
    isAppUpdateCheckAvailable() &&
    isForkUpdatesBuild(Constants.expoConfig?.updates?.url, Updates.channel)
  );
}

export function isDevChannelSelected(): boolean {
  return devChannelSelected;
}

/** Off removes the override, which restores the build's own `production` channel. */
export function selectDevChannel(enabled: boolean): void {
  Updates.setUpdateRequestHeadersOverride(
    enabled ? { "expo-channel-name": DEV_UPDATES_CHANNEL } : null,
  );
  devChannelSelected = enabled;
}

/** Resolves true when the dev channel has a bundle for this release and it is on the device. */
export async function downloadDevBundle(): Promise<boolean> {
  const check = await Updates.checkForUpdateAsync();
  if (!check.isAvailable) return false;
  await Updates.fetchUpdateAsync();
  return true;
}

export async function reloadIntoSelectedBundle(): Promise<void> {
  // A user-requested restart proceeds even when unsaved state could not be flushed.
  await defaultFlushPendingWrites().catch(() => undefined);
  await Updates.reloadAsync();
}
