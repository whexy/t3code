import { expect, it, vi } from "vite-plus/test";

import { resolveStableRelease } from "./stable-release.ts";

it("resolves the latest stable release tag", async () => {
  const fetchRelease = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ tag_name: "v0.1.9", draft: false, prerelease: false }));
  await expect(resolveStableRelease(fetchRelease, "ghs_token")).resolves.toBe("v0.1.9");
  const [url, init] = fetchRelease.mock.calls[0] ?? [];
  expect(url).toBe("https://api.github.com/repos/pingdotgg/t3code/releases/latest");
  expect(init?.headers).toMatchObject({ Authorization: "Bearer ghs_token" });
});

it.each([
  [{ tag_name: "v0.1.10-nightly.20261114.4682" }],
  [{ tag_name: "update-feed" }],
  [{}],
  [null],
])("rejects a release without a stable tag: %j", async (release) => {
  const fetchRelease = vi.fn<typeof fetch>().mockResolvedValue(Response.json(release));
  await expect(resolveStableRelease(fetchRelease)).rejects.toThrow("stable release tag");
});

it("fails without syncing when the release lookup fails", async () => {
  const fetchRelease = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
  await expect(resolveStableRelease(fetchRelease)).rejects.toThrow("GitHub answered 503");
});
