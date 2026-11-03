// @effect-diagnostics globalFetch:off globalDate:off - Stubs the browser's fetch that remote.ts calls.
import { describe, expect, it, vi } from "vite-plus/test";

import { listPolicies, loadPolicy, type RemoteList, type RemoteLoad } from "./remote.ts";

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
const LISTED = {
  name: "dotfiles",
  etag: '"v1"',
  size: 2,
  modifiedAt: "2026-11-02T23:19:03.000Z",
  publicUrl: "https://t3-policy.clusters.work/dotfiles.json",
};

describe("listPolicies", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly dev: boolean;
    readonly respond: () => Response | Promise<Response>;
    /** The list, or the message a failed list must name. */
    readonly expected: RemoteList | RegExp;
  }> = [
    {
      name: "the stored policies",
      dev: false,
      respond: () => json(200, JSON.stringify({ policies: [LISTED] })),
      expected: {
        status: "listed",
        policies: [
          {
            name: "dotfiles",
            etag: '"v1"',
            modifiedAt: new Date("2026-11-02T23:19:03Z"),
            publicUrl: LISTED.publicUrl,
          },
        ],
      },
    },
    {
      name: "a list it cannot read",
      dev: false,
      respond: () => json(200, JSON.stringify({ policies: [{ name: "x" }] })),
      expected: /cannot read/,
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
    const result = await listPolicies({ dev });
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

describe("loadPolicy", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly respond: () => Response | Promise<Response>;
    readonly expected: RemoteLoad | RegExp;
  }> = [
    {
      name: "a saved policy",
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
      name: "no policy by that name",
      respond: () => json(404, '{"error":"none"}'),
      expected: { status: "missing" },
    },
    {
      name: "a proxy's 404 page",
      respond: () => new Response("<html>", { status: 404 }),
      expected: /HTTP 404/,
    },
    {
      name: "a body that breaks off",
      respond: brokenBody,
      expected: /connection reset/,
    },
  ];

  it.each(cases)("reports $name", async ({ respond, expected }) => {
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => respond());
    const result = await loadPolicy("dotfiles");
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
