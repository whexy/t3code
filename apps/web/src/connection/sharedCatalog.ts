import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";

import type { CatalogBackend } from "./storage";

function sharedCatalogError(operation: "load" | "save", detail: string) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the shared connection catalog: ${detail}`,
  });
}

/**
 * Keeps the catalog on the serving origin (`VITE_SHARED_CATALOG_PATH`, served by
 * `scripts/self-hosted/server.ts`) so every browser behind it shares one set.
 * Writes carry the last ETag read; a 412 means another device saved first.
 */
export function makeSharedCatalogBackend(
  path: string,
  fetchCatalog: typeof fetch = (input, init) => globalThis.fetch(input, init),
): CatalogBackend {
  let etag: string | null = null;

  const request = (operation: "load" | "save", init: RequestInit) =>
    Effect.tryPromise({
      // An expired access-proxy session answers with a redirect to its login
      // page, which must fail instead of being read as the catalog.
      try: () =>
        fetchCatalog(path, {
          ...init,
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
        }),
      catch: (cause) => sharedCatalogError(operation, String(cause)),
    });

  return {
    read: Effect.gen(function* () {
      const response = yield* request("load", { method: "GET" });
      if (response.status === 404) {
        etag = null;
        return null;
      }
      if (!response.ok) {
        return yield* sharedCatalogError("load", `HTTP ${response.status}`);
      }
      const raw = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => sharedCatalogError("load", String(cause)),
      });
      etag = response.headers.get("ETag");
      return raw;
    }),
    write: Effect.fn("web.sharedCatalog.write")(function* (raw) {
      const response = yield* request("save", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(etag === null ? { "If-None-Match": "*" } : { "If-Match": etag }),
        },
        body: raw,
      });
      if (response.status === 412) {
        return yield* sharedCatalogError(
          "save",
          "another device changed it. Reload this page and try again.",
        );
      }
      if (!response.ok) {
        return yield* sharedCatalogError("save", `HTTP ${response.status}`);
      }
      etag = response.headers.get("ETag");
    }),
  };
}

export function sharedCatalogBackendFromEnv(): CatalogBackend | null {
  const path: unknown = import.meta.env.VITE_SHARED_CATALOG_PATH;
  return typeof path === "string" && path.trim() !== ""
    ? makeSharedCatalogBackend(path.trim())
    : null;
}
