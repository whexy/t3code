import * as NodeURL from "node:url";

export async function resolveStableRelease(fetchRelease = fetch) {
  // GitHub's latest endpoint excludes prereleases and drafts.
  const response = await fetchRelease(
    "https://api.github.com/repos/pingdotgg/t3code/releases/latest",
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Cannot resolve the upstream stable release: GitHub answered ${response.status}.`,
    );
  }
  const release: unknown = await response.json();
  if (
    typeof release !== "object" ||
    release === null ||
    !("tag_name" in release) ||
    typeof release.tag_name !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
    !("draft" in release) ||
    release.draft !== false ||
    !("prerelease" in release) ||
    release.prerelease !== false
  ) {
    throw new Error("GitHub did not return a published stable release.");
  }
  return release.tag_name;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  console.log(await resolveStableRelease());
}
