import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeSharedCatalogBackend } from "./sharedCatalog";

interface RecordedRequest {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

function fakeCatalogEndpoint(responses: ReadonlyArray<Response>) {
  const requests: RecordedRequest[] = [];
  let next = 0;
  const fetchCatalog: typeof fetch = async (_input, init) => {
    requests.push({
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === "string" ? init.body : null,
    });
    const response = responses[next++];
    if (response === undefined) throw new Error("unexpected catalog request");
    return response;
  };
  return { fetchCatalog, requests };
}

describe("makeSharedCatalogBackend", () => {
  it.effect("creates the catalog when none exists, then saves against the new ETag", () =>
    Effect.gen(function* () {
      const endpoint = fakeCatalogEndpoint([
        new Response(null, { status: 404 }),
        new Response(null, { status: 201, headers: { ETag: '"v1"' } }),
        new Response(null, { status: 200, headers: { ETag: '"v2"' } }),
      ]);
      const backend = makeSharedCatalogBackend("/catalog", endpoint.fetchCatalog);

      expect(yield* backend.read).toBeNull();
      yield* backend.write("first");
      yield* backend.write("second");

      expect(endpoint.requests.map((request) => request.headers)).toEqual([
        {},
        { "Content-Type": "application/json", "If-None-Match": "*" },
        { "Content-Type": "application/json", "If-Match": '"v1"' },
      ]);
      expect(endpoint.requests[2]?.body).toBe("second");
    }),
  );

  it.effect("refuses to overwrite a catalog another device saved first", () =>
    Effect.gen(function* () {
      const endpoint = fakeCatalogEndpoint([
        new Response("{}", { status: 200, headers: { ETag: '"v1"' } }),
        new Response(null, { status: 412 }),
      ]);
      const backend = makeSharedCatalogBackend("/catalog", endpoint.fetchCatalog);

      expect(yield* backend.read).toBe("{}");
      const error = yield* Effect.flip(backend.write("stale"));

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("another device changed it");
      expect(endpoint.requests[1]?.headers["If-Match"]).toBe('"v1"');
    }),
  );

  it.effect("fails loads the server rejects instead of starting empty", () =>
    Effect.gen(function* () {
      const endpoint = fakeCatalogEndpoint([new Response("denied", { status: 403 })]);
      const backend = makeSharedCatalogBackend("/catalog", endpoint.fetchCatalog);

      const error = yield* Effect.flip(backend.read);

      expect(error.message).toContain("HTTP 403");
    }),
  );
});
