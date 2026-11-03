import { expect, it, vi } from "vite-plus/test";

import { reportFailure } from "./report-failure.ts";

const env = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "whexy/t3code",
  GITHUB_RUN_ID: "42",
  GITHUB_REF_NAME: "self-hosted-nightly",
  GITHUB_SHA: "a".repeat(40),
  T3_FAILURE_RELEASE_TAG: "v0.1.7-nightly.20261102.4093",
  T3_REPAIR_WEBHOOK: "https://t3.example/hook",
  T3_ALERT_WEBHOOK: "https://n8n.example/alert",
};
const sentTo = (fetchUrl: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetchUrl.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))]);

it.each([
  [{ "nix-linux": "failure", mcp: "failure", gate: "skipped" }, "mcp,nix-linux"],
  [{ "web-hub": "success", notify: "cancelled" }, "cancelled"],
])("names a build's failed jobs as its stage: %j", async (results, stage) => {
  const fetchUrl = vi.fn<typeof fetch>().mockResolvedValue(new Response("started"));
  const needs = Object.fromEntries(
    Object.entries(results).map(([id, result]) => [id, { result, outputs: {} }]),
  );
  await expect(
    reportFailure("build", { ...env, T3_FAILURE_NEEDS: JSON.stringify(needs) }, fetchUrl, () => {}),
  ).resolves.toBe(true);
  expect(sentTo(fetchUrl)).toEqual([
    [
      "https://t3.example/hook",
      {
        kind: "build",
        stage,
        branch: "self-hosted-nightly",
        commit: "a".repeat(40),
        release_tag: "v0.1.7-nightly.20261102.4093",
        run_id: "42",
        run_url: "https://github.com/whexy/t3code/actions/runs/42",
      },
    ],
  ]);
});

it("alerts instead when the repair webhook does not answer 2xx", async () => {
  const fetchUrl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("gone", { status: 404 }))
    .mockResolvedValueOnce(new Response("ok"));
  const sync = { ...env, T3_FAILURE_STAGE: "rebase", T3_FAILURE_COMMIT: "b".repeat(40) };
  await expect(reportFailure("sync", sync, fetchUrl, () => {})).resolves.toBe(true);
  expect(sentTo(fetchUrl)[1]).toEqual([
    "https://n8n.example/alert",
    {
      source: "t3code-fork",
      severity: "error",
      title: "Fork sync failed at rebase",
      detail: `the repair webhook answered 404: gone. Commit ${"b".repeat(40)}, release v0.1.7-nightly.20261102.4093.`,
      url: "https://github.com/whexy/t3code/actions/runs/42",
    },
  ]);
});

it("says nobody was told when the alert webhook is unreachable too", async () => {
  const fetchUrl = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockRejectedValueOnce(new TypeError("fetch failed"));
  const log = vi.fn();
  await expect(reportFailure("sync", env, fetchUrl, log)).resolves.toBe(false);
  expect(log).toHaveBeenCalledWith(
    "Nobody was told: the repair webhook failed: TypeError: fetch failed, and the alert webhook failed: TypeError: fetch failed.",
  );
});

it("tells nobody, and says so, when neither webhook is set", async () => {
  const fetchUrl = vi.fn<typeof fetch>();
  const log = vi.fn();
  const unset = { ...env, T3_REPAIR_WEBHOOK: undefined, T3_ALERT_WEBHOOK: undefined };
  await expect(reportFailure("sync", unset, fetchUrl, log)).resolves.toBe(false);
  expect(fetchUrl).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    "Nobody was told: T3_REPAIR_WEBHOOK is not set, and T3_ALERT_WEBHOOK is not set.",
  );
});
