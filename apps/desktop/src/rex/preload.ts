import type { REX_DESKTOP_GLOBAL, RexDesktopBridge } from "@t3tools/contracts/rex";
import { contextBridge, ipcRenderer } from "electron";

import * as Channels from "./channels.ts";

// A value import would leave a require() the sandboxed preload cannot resolve.
const BRIDGE_GLOBAL: typeof REX_DESKTOP_GLOBAL = "t3Rex";

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, {
  available: () => ipcRenderer.invoke(Channels.REX_AVAILABLE_CHANNEL),
  select: (input) => ipcRenderer.invoke(Channels.REX_SELECT_CHANNEL, input),
} satisfies RexDesktopBridge);
