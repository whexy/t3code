// T3_REPAIR_WEBHOOK's task starts an agent run that repairs the branch and
// dedupes on kind, stage, commit, and release tag; T3_ALERT_WEBHOOK tells
// Wenxuan when that webhook is unset or does not answer 2xx. A sync names its
// stage in T3_FAILURE_STAGE, a build passes `toJSON(needs)` in T3_FAILURE_NEEDS.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

type Env = Readonly<Record<string, string | undefined>>;

export function failedJobs(needsJson: string) {
  const needs: Record<string, { readonly result?: string }> = JSON.parse(needsJson);
  const jobs = Object.entries(needs);
  const failed = jobs.filter(([, job]) => job.result === "failure").map(([id]) => id);
  if (failed.length > 0) return failed.toSorted().join(",");
  return jobs.some(([, job]) => job.result === "cancelled") ? "cancelled" : "unknown";
}

export function repairPayload(kind: "sync" | "build", env: Env) {
  const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  return {
    kind,
    stage:
      kind === "build"
        ? failedJobs(env.T3_FAILURE_NEEDS ?? "{}")
        : env.T3_FAILURE_STAGE || "unknown",
    branch: env.GITHUB_REF_NAME ?? "",
    commit: env.T3_FAILURE_COMMIT || env.GITHUB_SHA || "",
    release_tag: env.T3_FAILURE_RELEASE_TAG ?? "",
    run_id: env.GITHUB_RUN_ID ?? "",
    run_url: runUrl,
  };
}

const post = (fetchUrl: typeof fetch, url: string, body: unknown) =>
  fetchUrl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

/** Resolves whether anyone was told. */
export async function reportFailure(
  kind: "sync" | "build",
  env: Env,
  fetchUrl: typeof fetch = fetch,
  log: (line: string) => void = console.log,
) {
  const payload = repairPayload(kind, env);
  let reason = "T3_REPAIR_WEBHOOK is not set";
  if (env.T3_REPAIR_WEBHOOK) {
    try {
      const response = await post(fetchUrl, env.T3_REPAIR_WEBHOOK, payload);
      if (response.ok) {
        log(`Reported ${kind} ${payload.stage}: ${response.headers.get("x-t3-hook-outcome")}`);
        return true;
      }
      reason = `the repair webhook answered ${response.status}: ${await response.text()}`;
    } catch (error) {
      reason = `the repair webhook failed: ${String(error)}`;
    }
  }
  if (!env.T3_ALERT_WEBHOOK) {
    log(`Nobody was told: ${reason}, and T3_ALERT_WEBHOOK is not set.`);
    return false;
  }
  let alertFailure: string;
  try {
    const response = await post(fetchUrl, env.T3_ALERT_WEBHOOK, {
      source: "t3code-fork",
      severity: "error",
      title: `Fork ${kind} failed at ${payload.stage}`,
      detail: `${reason}. Commit ${payload.commit}, release ${payload.release_tag || "unknown"}.`,
      url: payload.run_url,
    });
    if (response.ok) {
      log(`Alerted instead: ${reason}.`);
      return true;
    }
    alertFailure = `answered ${response.status}`;
  } catch (error) {
    alertFailure = `failed: ${String(error)}`;
  }
  log(`Nobody was told: ${reason}, and the alert webhook ${alertFailure}.`);
  return false;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const kind = process.argv[2];
  if (kind !== "sync" && kind !== "build") {
    throw new Error("Usage: report-failure.ts <sync|build>");
  }
  // A sync's report step writes its own line, with the tag and start head.
  if (kind === "build" && process.env.GITHUB_STEP_SUMMARY) {
    const { stage, commit, release_tag } = repairPayload(kind, process.env);
    NodeFS.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `state=FAILED(${stage}) commit=${commit} release=${release_tag}\n`,
    );
  }
  if (!(await reportFailure(kind, process.env))) process.exitCode = 1;
}
