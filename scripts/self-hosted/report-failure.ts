// Reports a failed self-hosted pipeline to the T3 Code webhook in
// T3_REPAIR_WEBHOOK, whose scheduled task starts an agent run that repairs the
// branch. The task dedupes on kind, branch, commit, and release, so a sync
// stuck on one release reports once however many hourly runs fail on it.
import * as NodeFS from "node:fs";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

const kind = process.argv[2];
if (kind !== "sync" && kind !== "build") {
  throw new Error("Usage: report-failure.ts <sync|build>");
}

// The sync's rebase step records the release it tried; a failed lookup leaves none.
const releaseTagFile = ".sync/release-tag";
const releaseTag = NodeFS.existsSync(releaseTagFile)
  ? NodeFS.readFileSync(releaseTagFile, "utf8").trim()
  : "";

const response = await fetch(env("T3_REPAIR_WEBHOOK"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    kind,
    branch: env("CI_COMMIT_BRANCH"),
    commit: env("CI_COMMIT_SHA"),
    pipeline: env("CI_PIPELINE_NUMBER"),
    pipeline_url: process.env.CI_PIPELINE_URL ?? "",
    release_tag: releaseTag,
  }),
});
if (!response.ok) {
  throw new Error(`The webhook answered ${response.status}: ${await response.text()}`);
}
console.log(`Reported the failure: ${response.headers.get("x-t3-hook-outcome")}`);
