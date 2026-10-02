import { expect, it, vi } from "vite-plus/test";

import { resolveStableRelease } from "./stable-release.ts";

it("resolves the published stable tag using GitHub's latest release endpoint", async () => {
  const fetchRelease = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ tag_name: "v0.0.44", draft: false, prerelease: false }));
  await expect(resolveStableRelease(fetchRelease)).resolves.toBe("v0.0.44");
  expect(fetchRelease.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/repos/pingdotgg/t3code/releases/latest",
  );
});

it.each([
  { tag_name: "v0.0.45-nightly.20261001", draft: false, prerelease: true },
  { tag_name: "v0.0.45-preview.20261001", draft: false, prerelease: false },
  { tag_name: "v0.0.45", draft: true, prerelease: false },
  { tag_name: "v0.0.45" },
  null,
])("rejects an unpublished or non-stable release: %j", async (release) => {
  const fetchRelease = vi.fn<typeof fetch>().mockResolvedValue(Response.json(release));
  await expect(resolveStableRelease(fetchRelease)).rejects.toThrow("published stable release");
});

it("fails without syncing when the release lookup fails", async () => {
  const fetchRelease = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
  await expect(resolveStableRelease(fetchRelease)).rejects.toThrow("GitHub answered 503");
});
