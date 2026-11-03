// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercises the Node-only server over real HTTP, as hosts and the editor do.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createPolicyEditorServer, POLICY_PATH } from "./serve.ts";

async function startServer(input: { setup?: (policyDir: string) => Promise<void> } = {}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-policy-editor-"));
  const webRoot = NodePath.join(directory, "dist");
  const policyDir = NodePath.join(directory, "policy");
  await NodeFSP.mkdir(webRoot);
  await NodeFSP.mkdir(policyDir);
  await NodeFSP.writeFile(NodePath.join(webRoot, "index.html"), "<editor>");
  await input.setup?.(policyDir);

  const server = createPolicyEditorServer({ webRoot, policyDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  return {
    origin,
    policyDir,
    policyUrl: `${origin}${POLICY_PATH}`,
    [Symbol.asyncDispose]: async () => {
      await new Promise((resolve) => server.close(resolve));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

const put = (url: string, body: string, headers: Record<string, string>) =>
  fetch(url, { method: "PUT", body, headers });
const policy = (organization: string, extra = "") =>
  `{"schemaVersion":1,"organization":"${organization}"${extra}}\n`;
const etagOf = (raw: string) => `"${NodeCrypto.createHash("sha256").update(raw).digest("hex")}"`;

describe("/policy.json", () => {
  it("creates once, then only accepts writes based on the current version", async () => {
    await using server = await startServer();
    const { policyUrl } = server;

    const missing = await fetch(policyUrl);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "No policy has been saved yet." });
    expect((await put(policyUrl, policy("any"), { "If-Match": "*" })).status).toBe(412);

    const created = await put(policyUrl, policy("v1"), { "If-None-Match": "*" });
    expect(created.status).toBe(200);
    const v1 = created.headers.get("ETag")!;
    expect(v1).toBe(etagOf(policy("v1")));
    expect(await created.json()).toMatchObject({
      sha256: v1.slice(1, -1),
      size: policy("v1").length,
    });

    expect((await put(policyUrl, policy("again"), { "If-None-Match": "*" })).status).toBe(412);
    expect((await put(policyUrl, policy("v2"), {})).status).toBe(428);

    const updated = await put(policyUrl, policy("v2"), { "If-Match": v1 });
    expect(updated.status).toBe(200);
    expect((await put(policyUrl, policy("stale"), { "If-Match": v1 })).status).toBe(412);
    // A compressing proxy hands the browser a weak ETag.
    expect(
      (await put(policyUrl, policy("v3"), { "If-Match": `W/${updated.headers.get("ETag")}` }))
        .status,
    ).toBe(200);
    expect((await put(policyUrl, policy("v4"), { "If-Match": "*" })).status).toBe(200);

    const current = await fetch(policyUrl);
    expect(await current.text()).toBe(policy("v4"));
    expect(current.headers.get("ETag")).toBe(etagOf(policy("v4")));
    expect(current.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("stores only policy.json, as last saved", async () => {
    await using server = await startServer();
    const v1 = (await put(server.policyUrl, policy("v1"), { "If-None-Match": "*" })).headers.get(
      "ETag",
    )!;
    await put(server.policyUrl, policy("v2"), { "If-Match": v1 });

    const read = (name: string) => NodeFSP.readFile(NodePath.join(server.policyDir, name), "utf8");
    expect(await read("policy.json")).toBe(policy("v2"));
    expect(await NodeFSP.readdir(server.policyDir)).toEqual(["policy.json"]);
  });

  it("cleans up after a failed write, and the next write succeeds", async () => {
    await using server = await startServer({
      setup: (policyDir) => NodeFSP.writeFile(NodePath.join(policyDir, "policy.json.1.tmp"), "{"),
    });
    const v1 = (await put(server.policyUrl, policy("v1"), { "If-None-Match": "*" })).headers.get(
      "ETag",
    )!;
    expect(await NodeFSP.readdir(server.policyDir)).toEqual(["policy.json"]);

    // A dangling link where the temporary file goes makes opening it fail.
    await NodeFSP.symlink(
      NodePath.join(server.policyDir, "missing", "policy.json"),
      NodePath.join(server.policyDir, `policy.json.${process.pid}.tmp`),
    );
    expect((await put(server.policyUrl, policy("v2"), { "If-Match": v1 })).status).toBe(500);
    expect(await NodeFSP.readdir(server.policyDir)).toEqual(["policy.json"]);
    expect(await (await fetch(server.policyUrl)).text()).toBe(policy("v1"));

    expect((await put(server.policyUrl, policy("v2"), { "If-Match": v1 })).status).toBe(200);
    expect(await (await fetch(server.policyUrl)).text()).toBe(policy("v2"));
  });

  it("lets exactly one of two concurrent saves from the same version win", async () => {
    await using server = await startServer();
    const v1 = (await put(server.policyUrl, policy("v1"), { "If-None-Match": "*" })).headers.get(
      "ETag",
    )!;

    const results = await Promise.all(
      ["a", "b"].map(async (organization) => {
        const response = await put(server.policyUrl, policy(organization), { "If-Match": v1 });
        return { organization, status: response.status };
      }),
    );

    expect(results.map((result) => result.status).toSorted()).toEqual([200, 412]);
    const winner = results.find((result) => result.status === 200)!.organization;
    expect(await (await fetch(server.policyUrl)).text()).toBe(policy(winner));
  });

  it("refuses bodies that are not a version 1 policy, and keeps the saved one", async () => {
    await using server = await startServer();
    const create = { "If-None-Match": "*" };
    const refusals = await Promise.all(
      [
        ["{oops", /not valid JSON/],
        ["[]", /a JSON object/],
        ['{"schemaVersion":2,"organization":"x"}', /schemaVersion must be 1/],
        ['{"schemaVersion":1}', /organization must be a string/],
        [policy("big", `,"pad":"${"x".repeat(256 * 1024)}"`), /at most 256 KiB/],
      ].map(async ([body, message]) => {
        const response = await put(server.policyUrl, body as string, create);
        return {
          status: response.status,
          error: ((await response.json()) as { error: string }).error,
          message,
        };
      }),
    );
    for (const refusal of refusals) expect(refusal.error).toMatch(refusal.message as RegExp);
    expect(refusals.map((refusal) => refusal.status)).toEqual([400, 400, 400, 400, 413]);
    expect((await fetch(server.policyUrl)).status).toBe(404);
  });
});

describe("/healthz", () => {
  it("reports whether POLICY_DIR is a writable directory", async () => {
    await using writable = await startServer();
    expect((await fetch(`${writable.origin}/healthz`)).status).toBe(200);

    for (const setup of [
      (policyDir: string) => NodeFSP.rm(policyDir, { recursive: true }),
      async (policyDir: string) => {
        await NodeFSP.rm(policyDir, { recursive: true });
        await NodeFSP.writeFile(policyDir, "");
      },
    ]) {
      await using broken = await startServer({ setup });
      const response = await fetch(`${broken.origin}/healthz`);
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toMatch(/POLICY_DIR/);
    }
  });
});

describe("static files", () => {
  it("serves the editor and answers 404 for paths it cannot decode", async () => {
    await using server = await startServer();
    expect(await (await fetch(`${server.origin}/`)).text()).toBe("<editor>");
    expect((await fetch(`${server.origin}/%E0%A4%A`)).status).toBe(404);
  });

  it("answers 400 to a request URL it cannot parse, and keeps serving", async () => {
    await using server = await startServer();
    // fetch would normalize this URL, so send the raw request line.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      NodeHttp.get(`${server.origin}/`, { path: "//[" }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    expect(status).toBe(400);
    expect((await fetch(`${server.origin}/healthz`)).status).toBe(200);
  });
});
