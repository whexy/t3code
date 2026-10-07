import { expect, it, vi } from "vite-plus/test";

import { resolveNightlyRelease } from "./nightly-release.ts";

const nightly = (tag_name: string, published_at: string) => ({
  tag_name,
  draft: false,
  prerelease: true,
  published_at,
});

it("resolves the most recently published nightly tag", async () => {
  const fetchReleases = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json([
      {
        tag_name: "v0.0.46",
        draft: false,
        prerelease: false,
        published_at: "2026-10-08T00:00:00Z",
      },
      nightly("v0.0.46-nightly.20261007.2774", "2026-10-07T12:00:49Z"),
      nightly("v0.0.46-nightly.20261007.2787", "2026-10-07T18:45:29Z"),
      nightly("v0.0.46-nightly.20261006.2752", "2026-10-07T00:09:56Z"),
    ]),
  );
  await expect(resolveNightlyRelease(fetchReleases)).resolves.toBe("v0.0.46-nightly.20261007.2787");
  expect(fetchReleases.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=30",
  );
});

it.each([
  [
    [
      {
        tag_name: "v0.0.46-nightly.20261007.2787",
        draft: true,
        prerelease: true,
        published_at: null,
      },
    ],
  ],
  [
    [
      {
        tag_name: "v0.0.46-preview.20261007",
        draft: false,
        prerelease: true,
        published_at: "2026-10-07T00:00:00Z",
      },
    ],
  ],
  [
    [
      {
        tag_name: "v0.0.45",
        draft: false,
        prerelease: false,
        published_at: "2026-10-01T00:00:00Z",
      },
    ],
  ],
  [[]],
  [null],
])("rejects a list without a published nightly: %j", async (releases) => {
  const fetchReleases = vi.fn<typeof fetch>().mockResolvedValue(Response.json(releases));
  await expect(resolveNightlyRelease(fetchReleases)).rejects.toThrow("published nightly release");
});

it("fails without syncing when the release lookup fails", async () => {
  const fetchReleases = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 503 }));
  await expect(resolveNightlyRelease(fetchReleases)).rejects.toThrow("GitHub answered 503");
});
