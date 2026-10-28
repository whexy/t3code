import * as NodeURL from "node:url";

const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;

export async function resolveNightlyRelease(fetchReleases = fetch) {
  // GitHub's latest endpoint excludes prereleases, so pick from the recent list.
  const response = await fetchReleases(
    "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=30",
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Cannot resolve the upstream nightly release: GitHub answered ${response.status}.`,
    );
  }
  const releases: unknown = await response.json();
  let newest: { readonly tag: string; readonly publishedAt: number } | null = null;
  const candidates: ReadonlyArray<unknown> = Array.isArray(releases) ? releases : [];
  for (const release of candidates) {
    if (
      typeof release !== "object" ||
      release === null ||
      !("tag_name" in release) ||
      typeof release.tag_name !== "string" ||
      !NIGHTLY_TAG.test(release.tag_name) ||
      !("draft" in release) ||
      release.draft !== false ||
      !("prerelease" in release) ||
      release.prerelease !== true ||
      !("published_at" in release) ||
      typeof release.published_at !== "string"
    ) {
      continue;
    }
    const publishedAt = Date.parse(release.published_at);
    if (!Number.isNaN(publishedAt) && (newest === null || publishedAt > newest.publishedAt)) {
      newest = { tag: release.tag_name, publishedAt };
    }
  }
  if (newest === null) {
    throw new Error("GitHub did not return a published nightly release.");
  }
  return newest.tag;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  console.log(await resolveNightlyRelease());
}
