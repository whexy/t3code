import {
  DEV_UPDATES_DESKTOP_GLOBAL,
  DEV_UPDATES_HUB_PATH,
  type DevUpdatesBridge,
  type DevUpdatesState,
} from "@t3tools/shared/devUpdates";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

declare global {
  interface Window {
    [DEV_UPDATES_DESKTOP_GLOBAL]?: DevUpdatesBridge;
  }
}

export type DevUpdatesBackendKind = "desktop" | "hub";

interface DevUpdatesBackend {
  readonly kind: DevUpdatesBackendKind;
  /** null when this server has no dev lane. */
  readonly getState: () => Promise<DevUpdatesState | null>;
  readonly setEnabled: (enabled: boolean) => Promise<DevUpdatesState>;
}

class DevUpdatesLoadError extends Schema.TaggedError<DevUpdatesLoadError>()("DevUpdatesLoadError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Failed to load the dev updates state.";
  }
}

async function hubRequest(init?: RequestInit) {
  // An expired access-proxy session redirects to its login page, which must not read as state.
  const response = await globalThis.fetch(DEV_UPDATES_HUB_PATH, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Dev updates: HTTP ${response.status}`);
  return (await response.json()) as DevUpdatesState;
}

const hubBackend: DevUpdatesBackend = {
  kind: "hub",
  getState: () => hubRequest(),
  setEnabled: async (enabled) => {
    const state = await hubRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (state === null) throw new Error("This server has no dev updates.");
    return state;
  },
};

export function resolveDevUpdatesBackend(): DevUpdatesBackend | null {
  if (typeof window === "undefined") return null;
  const desktop = window[DEV_UPDATES_DESKTOP_GLOBAL];
  if (desktop) {
    return { kind: "desktop", getState: () => desktop.getState(), setEnabled: desktop.setEnabled };
  }
  // Only the hub image (scripts/self-hosted) is built with a shared catalog, so other
  // servers' web UIs never probe a path they do not serve.
  const sharedCatalogPath: unknown = import.meta.env.VITE_SHARED_CATALOG_PATH;
  return typeof sharedCatalogPath === "string" && sharedCatalogPath.trim() !== ""
    ? hubBackend
    : null;
}

const loadDevUpdates = Effect.fn("loadDevUpdates")(function* () {
  const backend = resolveDevUpdatesBackend();
  if (backend === null) return null;
  const state = yield* Effect.tryPromise({
    try: () => backend.getState(),
    catch: (cause) => new DevUpdatesLoadError({ cause }),
  });
  return state === null ? null : { kind: backend.kind, state };
});

export const devUpdatesAtom = Atom.make(loadDevUpdates()).pipe(
  Atom.keepAlive,
  Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
  Atom.withLabel("dev-updates:load"),
);

export async function setDevUpdatesEnabled(enabled: boolean): Promise<void> {
  const backend = resolveDevUpdatesBackend();
  if (backend === null) return;
  await backend.setEnabled(enabled);
  appAtomRegistry.refresh(devUpdatesAtom);
}
