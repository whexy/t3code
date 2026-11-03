// @effect-diagnostics globalFetch:off globalDate:off - Stubs the browser's fetch that remote.ts calls.
import { describe, expect, it, vi } from "vite-plus/test";

import { loadRemotePolicy, type RemoteLoad } from "./remote.ts";

const json = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "application/json", ...headers } });
const brokenBody = () =>
  new Response(
    new ReadableStream({
      start: (controller) => controller.error(new Error("connection reset")),
    }),
    { headers: { "Content-Type": "application/json", ETag: '"v1"' } },
  );
const timeout = () => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};

describe("loadRemotePolicy", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly dev: boolean;
    readonly respond: () => Response | Promise<Response>;
    /** The load, or the message a failed load must name. */
    readonly expected: RemoteLoad | RegExp;
  }> = [
    {
      name: "a saved policy",
      dev: false,
      respond: () =>
        json(200, "{}", { ETag: '"v1"', "Last-Modified": "Mon, 02 Nov 2026 23:19:03 GMT" }),
      expected: {
        status: "saved",
        text: "{}",
        etag: '"v1"',
        savedAt: new Date("2026-11-02T23:19:03Z"),
      },
    },
    {
      name: "none saved yet",
      dev: false,
      respond: () => json(404, '{"error":"none"}'),
      expected: { status: "empty" },
    },
    {
      name: "a proxy error page",
      dev: false,
      respond: () => new Response("<html>", { status: 502 }),
      expected: /HTTP 502/,
    },
    {
      name: "a server error",
      dev: false,
      respond: () => json(500, '{"error":"disk full"}'),
      expected: /disk full/,
    },
    {
      name: "no connection",
      dev: false,
      respond: () => Promise.reject(new TypeError("fetch failed")),
      expected: /fetch failed/,
    },
    { name: "a timeout", dev: false, respond: timeout, expected: /did not answer/ },
    {
      name: "a body that breaks off",
      dev: false,
      respond: brokenBody,
      expected: /connection reset/,
    },
    {
      name: "no policy server under vp dev",
      dev: true,
      respond: () => new Response("<html>", { status: 404 }),
      expected: { status: "absent" },
    },
    {
      name: "no connection under vp dev",
      dev: true,
      respond: () => Promise.reject(new TypeError("fetch failed")),
      expected: { status: "absent" },
    },
  ];

  it.each(cases)("reports $name", async ({ dev, respond, expected }) => {
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => respond());
    const result = await loadRemotePolicy({ dev });
    if (expected instanceof RegExp) {
      expect(result).toMatchObject({
        status: "failed",
        message: expect.stringMatching(expected),
      });
    } else {
      expect(result).toEqual(expected);
    }
  });
});
