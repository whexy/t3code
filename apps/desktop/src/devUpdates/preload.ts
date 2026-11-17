import type { DevUpdatesBridge, DEV_UPDATES_DESKTOP_GLOBAL } from "@t3tools/shared/devUpdates";
import { contextBridge, ipcRenderer } from "electron";

import * as Channels from "./channels.ts";

// A value import would leave a require() the sandboxed preload cannot resolve.
const BRIDGE_GLOBAL: typeof DEV_UPDATES_DESKTOP_GLOBAL = "t3DevUpdates";

let available = false;
try {
  available = ipcRenderer.sendSync(Channels.DEV_UPDATES_AVAILABLE_CHANNEL) === true;
} catch {}

if (available) {
  contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, {
    getState: () => ipcRenderer.invoke(Channels.DEV_UPDATES_GET_STATE_CHANNEL),
    setEnabled: (enabled) => ipcRenderer.invoke(Channels.DEV_UPDATES_SET_ENABLED_CHANNEL, enabled),
    reload: () => ipcRenderer.invoke(Channels.DEV_UPDATES_RELOAD_CHANNEL),
  } satisfies DevUpdatesBridge);

  // React replaces #boot-shell when the app mounts; apps/web's showBootError fills it with
  // #boot-error-reload instead. Either tells the main process whether a dev bundle started.
  const watchBoot = () => {
    const root = document.getElementById("root");
    if (root === null) return;
    const observer = new MutationObserver(() => report());
    const report = () => {
      const outcome =
        document.getElementById("boot-error-reload") !== null
          ? "failed"
          : document.getElementById("boot-shell") === null
            ? "started"
            : null;
      if (outcome === null) return;
      observer.disconnect();
      void ipcRenderer
        .invoke(Channels.DEV_UPDATES_RENDERER_BOOT_CHANNEL, outcome)
        .catch(() => undefined);
    };
    observer.observe(root, { childList: true, subtree: true });
    report();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchBoot, { once: true });
  } else {
    watchBoot();
  }
}
