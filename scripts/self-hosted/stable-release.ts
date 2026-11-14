// @effect-diagnostics globalConsole:off - CI runs this copy without an install and reads the tag from stdout.
import * as NodeURL from "node:url";

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

// Shared CI runners exhaust GitHub's anonymous rate limit, so pass a token there.
export async function resolveStableRelease(fetchRelease = fetch, token = process.env.GITHUB_TOKEN) {
  // GitHub's latest release excludes drafts and prereleases.
  const response = await fetchRelease(
    "https://api.github.com/repos/pingdotgg/t3code/releases/latest",
    {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
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
    !STABLE_TAG.test(release.tag_name)
  ) {
    throw new Error("GitHub did not return a stable release tag.");
  }
  return release.tag_name;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  console.log(await resolveStableRelease());
}
