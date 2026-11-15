import { expect, it, vi } from "vite-plus/test";

import {
  decide,
  plan,
  releaseOwnedChanges,
  resolveDesktop,
  resolveIos,
  resolveWeb,
  type Platform,
} from "./dev-ota.ts";

const sha = (char: string) => char.repeat(40);

function fakeApi(routes: Record<string, unknown>) {
  return vi.fn(async (path: string) => {
    if (!(path in routes)) throw new Error(`unexpected GitHub request: ${path}`);
    return routes[path];
  });
}

it.each<[string, ReadonlyArray<Platform>]>([
  ["apps/web/src/components/ChatView.tsx", []],
  ["apps/mobile/src/app.tsx", []],
  ["apps/server/src/ws.ts", []],
  ["packages/shared/src/devUpdates.ts", []],
  ["packages/contracts/src/orchestration.ts", ["ios", "desktop", "web"]],
  ["apps/desktop/src/main.ts", ["desktop"]],
  ["apps/desktop/src/preload.ts", ["desktop"]],
  ["apps/desktop/src/main.test.ts", []],
  ["apps/desktop/src/updates/updatesTestHarness.ts", []],
  ["scripts/self-hosted/server.ts", ["web"]],
  ["scripts/self-hosted/Dockerfile", ["web"]],
  ["scripts/self-hosted/server.test.ts", []],
])("a change to %s needs a release for %j", (path, blocked) => {
  const platforms: ReadonlyArray<Platform> = ["ios", "desktop", "web"];
  expect(platforms.filter((platform) => releaseOwnedChanges(platform, [path]).length > 0)).toEqual(
    blocked,
  );
});

it("publishes for the release it checked, and names what blocks it otherwise", () => {
  const ios = { runtimeVersion: "1.2.139", commit: sha("a"), fingerprint: "f00d" };
  expect(decide("ios", ios, ["apps/mobile/src/app.tsx"])).toEqual({
    publish: true,
    runtimeVersion: "1.2.139",
    target: sha("a"),
    fingerprint: "f00d",
  });
  expect(
    decide("web", { runtimeVersion: "1.2.139", commit: sha("a") }, [
      "packages/contracts/src/a.ts",
      "scripts/self-hosted/server.ts",
    ]),
  ).toEqual({
    publish: false,
    reason: "packages/contracts, scripts/self-hosted/server.ts changed",
  });
  expect(decide("desktop", null, [])).toEqual({ publish: false, reason: "no release" });
  expect(decide("ios", { runtimeVersion: "1.2.130", commit: sha("a") }, [])).toEqual({
    publish: false,
    reason: "ios/1.2.130 records no fingerprint",
  });
});

it("takes the newest ios/1.2.N tag and the fingerprint its message records", async () => {
  const api = fakeApi({
    "git/matching-refs/tags/ios/": [
      { ref: "refs/tags/ios/1.2.99", object: { sha: sha("1"), type: "tag" } },
      { ref: "refs/tags/ios/1.2.139", object: { sha: sha("2"), type: "tag" } },
      { ref: "refs/tags/ios/1.2.137", object: { sha: sha("3"), type: "tag" } },
      { ref: "refs/tags/ios/scratch", object: { sha: sha("4"), type: "commit" } },
    ],
    [`git/tags/${sha("2")}`]: {
      message: "TestFlight 1.2.139\n\nfingerprint: 0123abcd\n",
      object: { sha: sha("c"), type: "commit" },
    },
  });
  await expect(resolveIos(api)).resolves.toEqual({
    runtimeVersion: "1.2.139",
    commit: sha("c"),
    fingerprint: "0123abcd",
  });
});

it("targets the newest build whose hub image was promoted", async () => {
  const api = fakeApi({
    "actions/workflows/self-hosted-build.yml/runs?branch=self-hosted-nightly&per_page=30": {
      workflow_runs: [
        { id: 3, run_number: 141, head_sha: sha("3"), event: "push" },
        { id: 2, run_number: 140, head_sha: sha("2"), event: "workflow_dispatch" },
        { id: 1, run_number: 139, head_sha: sha("1"), event: "push" },
      ],
    },
    // Superseded: the gate passed, but the branch had moved on.
    "actions/runs/3/jobs?filter=latest&per_page=100": {
      jobs: [
        { name: "gate", conclusion: "success" },
        { name: "promote-images", conclusion: "skipped" },
      ],
    },
    "actions/runs/2/jobs?filter=latest&per_page=100": {
      jobs: [
        { name: "promote-images", conclusion: "success" },
        { name: "publish-desktop", conclusion: "failure" },
      ],
    },
  });
  await expect(resolveWeb(api)).resolves.toEqual({ runtimeVersion: "1.2.140", commit: sha("2") });
});

it("targets the newest desktop prerelease at its tag's commit", async () => {
  const newest = "0.1.10-nightly.20261114.4682.20261115143930";
  const api = fakeApi({
    "releases?per_page=50": [
      { tag_name: "v9.9.9", created_at: "2026-11-16T00:00:00Z", draft: false, prerelease: false },
      {
        tag_name: "0.1.10-nightly.20261114.4682.20261114185756",
        created_at: "2026-11-14T18:57:56Z",
        draft: false,
        prerelease: true,
      },
      { tag_name: newest, created_at: "2026-11-15T14:39:30Z", draft: false, prerelease: true },
      {
        tag_name: "0.1.10-nightly.20261115.4700.20261115200000",
        created_at: "2026-11-15T20:00:00Z",
        draft: true,
        prerelease: true,
      },
    ],
    [`git/ref/tags/${newest}`]: { object: { sha: sha("d"), type: "commit" } },
  });
  await expect(resolveDesktop(api)).resolves.toEqual({ runtimeVersion: newest, commit: sha("d") });
});

it("diffs each release commit once, and plans nothing without the publishing secrets", async () => {
  const api = fakeApi({
    "git/matching-refs/tags/ios/": [
      { ref: "refs/tags/ios/1.2.139", object: { sha: sha("1"), type: "tag" } },
    ],
    [`git/tags/${sha("1")}`]: { message: "fingerprint: beef\n", object: { sha: sha("a") } },
    "actions/workflows/self-hosted-build.yml/runs?branch=self-hosted-nightly&per_page=30": {
      workflow_runs: [{ id: 1, run_number: 139, head_sha: sha("a"), event: "push" }],
    },
    "actions/runs/1/jobs?filter=latest&per_page=100": {
      jobs: [{ name: "promote-images", conclusion: "success" }],
    },
    "releases?per_page=50": [],
  });
  const diff = vi.fn(() => ["apps/desktop/src/main.ts", "apps/web/src/main.tsx"]);

  await expect(plan(api, diff, [])).resolves.toEqual({
    ios: { publish: true, runtimeVersion: "1.2.139", target: sha("a"), fingerprint: "beef" },
    desktop: { publish: false, reason: "no release" },
    web: { publish: true, runtimeVersion: "1.2.139", target: sha("a") },
  });
  expect(diff.mock.calls).toEqual([[sha("a")]]);

  const untouched = fakeApi({});
  const skipped = { publish: false, reason: "OTA_PUBLISH_TOKEN not set" };
  await expect(plan(untouched, diff, ["OTA_PUBLISH_TOKEN"])).resolves.toEqual({
    ios: skipped,
    desktop: skipped,
    web: skipped,
  });
  expect(untouched).not.toHaveBeenCalled();
});
