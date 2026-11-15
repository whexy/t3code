// @effect-diagnostics nodeBuiltinImport:off - CI runs this without an install, so only Node built-ins exist.
// Plans self-hosted-dev-ota.yml: a client gets HEAD's bundle only when HEAD
// differs from its release's commit in client code alone. Rebases force-push
// self-hosted-nightly, so each release commit is found, and fetched, by a tag.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export type Platform = "ios" | "desktop" | "web";
const PLATFORMS: ReadonlyArray<Platform> = ["ios", "desktop", "web"];

interface Target {
  readonly runtimeVersion: string;
  readonly commit: string;
  // ios only: the native fingerprint recorded on the release's `ios/1.2.N` tag.
  readonly fingerprint?: string | undefined;
}

type Decision =
  | {
      readonly publish: true;
      readonly runtimeVersion: string;
      readonly target: string;
      readonly fingerprint?: string | undefined;
    }
  | { readonly publish: false; readonly reason: string };

const isTest = (path: string) => /(?:\.test|TestHarness)\.[cm]?tsx?$/.test(path);

// The paths each target's release fixes; a bundle that needs them changed needs a release.
const RELEASE_OWNED: ReadonlyArray<{
  readonly name: string;
  readonly platforms: ReadonlyArray<Platform>;
  readonly matches: (path: string) => boolean;
}> = [
  {
    name: "packages/contracts",
    platforms: PLATFORMS,
    matches: (path) => path.startsWith("packages/contracts/"),
  },
  {
    name: "apps/desktop/src",
    platforms: ["desktop"],
    matches: (path) => path.startsWith("apps/desktop/src/") && !isTest(path),
  },
  {
    name: "scripts/self-hosted/server.ts",
    platforms: ["web"],
    matches: (path) => path === "scripts/self-hosted/server.ts",
  },
  {
    name: "scripts/self-hosted/Dockerfile",
    platforms: ["web"],
    matches: (path) => path === "scripts/self-hosted/Dockerfile",
  },
];

export function releaseOwnedChanges(platform: Platform, changed: ReadonlyArray<string>) {
  return RELEASE_OWNED.filter(
    (rule) => rule.platforms.includes(platform) && changed.some(rule.matches),
  ).map((rule) => rule.name);
}

// The native fingerprint is not a path rule: the ios job computes HEAD's and compares it.
export function decide(
  platform: Platform,
  target: Target | null,
  changed: ReadonlyArray<string>,
): Decision {
  if (!target) return { publish: false, reason: "no release" };
  if (platform === "ios" && !target.fingerprint) {
    return { publish: false, reason: `ios/${target.runtimeVersion} records no fingerprint` };
  }
  const blocking = releaseOwnedChanges(platform, changed);
  if (blocking.length > 0) return { publish: false, reason: `${blocking.join(", ")} changed` };
  return {
    publish: true,
    runtimeVersion: target.runtimeVersion,
    target: target.commit,
    ...(platform === "ios" ? { fingerprint: target.fingerprint } : {}),
  };
}

type Api = (path: string) => Promise<unknown>;

function githubApi(repository: string, token: string | undefined, fetchUrl = fetch): Api {
  return async (path) => {
    const response = await fetchUrl(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
    return response.json();
  };
}

const RELEASE = /^1\.2\.(\d+)$/;

// The build's ios-testflight job tags each uploaded build `ios/1.2.N`, an
// annotated tag on its commit whose message records the native fingerprint.
export async function resolveIos(api: Api): Promise<Target | null> {
  const refs = (await api("git/matching-refs/tags/ios/")) as ReadonlyArray<{
    readonly ref: string;
    readonly object: { readonly sha: string; readonly type: string };
  }>;
  const newest = refs
    .flatMap((ref) => {
      const version = ref.ref.slice("refs/tags/ios/".length);
      const run = RELEASE.exec(version)?.[1];
      return run ? [{ ref, version, run: Number(run) }] : [];
    })
    .toSorted((a, b) => b.run - a.run)
    .at(0);
  if (!newest) return null;
  if (newest.ref.object.type !== "tag") {
    return { runtimeVersion: newest.version, commit: newest.ref.object.sha };
  }
  const tag = (await api(`git/tags/${newest.ref.object.sha}`)) as {
    readonly message: string;
    readonly object: { readonly sha: string };
  };
  return {
    runtimeVersion: newest.version,
    commit: tag.object.sha,
    fingerprint: /^fingerprint: ([0-9a-f]+)$/m.exec(tag.message)?.[1],
  };
}

// The hub image takes 1.2.<run_number> in promote-images; promote-pin tags
// the commit pin/<sha12> in the same run, which keeps it fetchable.
export async function resolveWeb(api: Api): Promise<Target | null> {
  const { workflow_runs: runs } = (await api(
    "actions/workflows/self-hosted-build.yml/runs?branch=self-hosted-nightly&per_page=30",
  )) as {
    readonly workflow_runs: ReadonlyArray<{
      readonly id: number;
      readonly run_number: number;
      readonly head_sha: string;
      readonly event: string;
    }>;
  };
  for (const run of runs.toSorted((a, b) => b.run_number - a.run_number)) {
    if (run.event === "pull_request") continue;
    const { jobs } = (await api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)) as {
      readonly jobs: ReadonlyArray<{ readonly name: string; readonly conclusion: string | null }>;
    };
    if (jobs.some((job) => job.name === "promote-images" && job.conclusion === "success")) {
      return { runtimeVersion: `1.2.${run.run_number}`, commit: run.head_sha };
    }
  }
  return null;
}

const DESKTOP_RELEASE = /^\d+\.\d+\.\d+-nightly\./;

// A desktop prerelease's tag is the app's version, on the commit it was built from.
export async function resolveDesktop(api: Api): Promise<Target | null> {
  const releases = (await api("releases?per_page=50")) as ReadonlyArray<{
    readonly tag_name: string;
    readonly created_at: string;
    readonly draft: boolean;
    readonly prerelease: boolean;
  }>;
  const newest = releases
    .filter((release) => release.prerelease && !release.draft)
    .filter((release) => DESKTOP_RELEASE.test(release.tag_name))
    .toSorted((a, b) => b.created_at.localeCompare(a.created_at))
    .at(0);
  if (!newest) return null;
  const ref = (await api(`git/ref/tags/${encodeURIComponent(newest.tag_name)}`)) as {
    readonly object: { readonly sha: string; readonly type: string };
  };
  const commit =
    ref.object.type === "tag"
      ? ((await api(`git/tags/${ref.object.sha}`)) as { readonly object: { readonly sha: string } })
          .object.sha
      : ref.object.sha;
  return { runtimeVersion: newest.tag_name, commit };
}

const git = (...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();

function changedSince(commit: string) {
  git("fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none", "origin", commit);
  return git("diff", "--no-renames", "--name-only", commit, "HEAD").split("\n").filter(Boolean);
}

export async function plan(
  api: Api,
  diff: (commit: string) => ReadonlyArray<string>,
  missingSecrets: ReadonlyArray<string>,
): Promise<Record<Platform, Decision>> {
  if (missingSecrets.length > 0) {
    const skipped = { publish: false, reason: `${missingSecrets.join(", ")} not set` } as const;
    return { ios: skipped, desktop: skipped, web: skipped };
  }
  const [ios, desktop, web] = await Promise.all([
    resolveIos(api),
    resolveDesktop(api),
    resolveWeb(api),
  ]);
  const targets = { ios, desktop, web };
  const diffs = new Map<string, ReadonlyArray<string>>();
  const changed = (target: Target | null) => {
    if (!target) return [];
    if (!diffs.has(target.commit)) diffs.set(target.commit, diff(target.commit));
    return diffs.get(target.commit)!;
  };
  return {
    ios: decide("ios", targets.ios, changed(targets.ios)),
    desktop: decide("desktop", targets.desktop, changed(targets.desktop)),
    web: decide("web", targets.web, changed(targets.web)),
  };
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const env = process.env;
  const missing = ["OTA_PUBLISH_TOKEN"].filter((name) => env[`HAS_${name}`] !== "true");
  const decisions = await plan(
    githubApi(env.GITHUB_REPOSITORY ?? "whexy/t3code", env.GH_TOKEN),
    changedSince,
    missing,
  );
  const result = {
    commit: git("rev-parse", "HEAD"),
    message: git("log", "-1", "--format=%s"),
    ...decisions,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (env.GITHUB_OUTPUT)
    NodeFS.appendFileSync(env.GITHUB_OUTPUT, `plan=${JSON.stringify(result)}\n`);
}
