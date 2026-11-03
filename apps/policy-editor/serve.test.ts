// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercises the Node-only server over real HTTP, as hosts and the editor do.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { API_PATH, createAdminServer, createPublicServer, openPolicyStore } from "./serve.ts";

const listen = async (server: NodeHttp.Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
};

async function startServer(input: { setup?: (policyDir: string) => Promise<void> } = {}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-policy-editor-"));
  const webRoot = NodePath.join(directory, "dist");
  const policyDir = NodePath.join(directory, "policy");
  await NodeFSP.mkdir(webRoot);
  await NodeFSP.mkdir(policyDir);
  await NodeFSP.writeFile(NodePath.join(webRoot, "index.html"), "<editor>");
  await input.setup?.(policyDir);

  const store = await openPolicyStore(policyDir);
  const admin = createAdminServer({ webRoot, store, publicUrl: "https://policy.example/" });
  const publicServer = createPublicServer({ store });
  const origin = await listen(admin);
  const publicOrigin = await listen(publicServer);
  return {
    origin,
    publicOrigin,
    policyDir,
    policyUrl: (name: string) => `${origin}${API_PATH}/${name}`,
    read: (file: string) => NodeFSP.readFile(NodePath.join(policyDir, file), "utf8"),
    [Symbol.asyncDispose]: async () => {
      await Promise.all(
        [admin, publicServer].map((server) => new Promise((resolve) => server.close(resolve))),
      );
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

const put = (url: string, body: string, headers: Record<string, string>) =>
  fetch(url, { method: "PUT", body, headers });
const remove = (url: string, headers: Record<string, string>) =>
  fetch(url, { method: "DELETE", headers });
const policy = (organization: string, extra = "") =>
  `{"schemaVersion":1,"organization":"${organization}"${extra}}\n`;
const sha256 = (raw: string) => NodeCrypto.createHash("sha256").update(raw).digest("hex");
const etagOf = (raw: string) => `"${sha256(raw)}"`;
const create = (url: string, body: string) => put(url, body, { "If-None-Match": "*" });

describe("/api/policies/<name>", () => {
  it("creates once, then only accepts writes based on the current version", async () => {
    await using server = await startServer();
    const url = server.policyUrl("dotfiles");

    const missing = await fetch(url);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "There is no policy named dotfiles." });
    expect((await put(url, policy("any"), { "If-Match": "*" })).status).toBe(412);

    const created = await create(url, policy("v1"));
    expect(created.status).toBe(200);
    const v1 = created.headers.get("ETag")!;
    expect(v1).toBe(etagOf(policy("v1")));
    expect(await created.json()).toMatchObject({
      name: "dotfiles",
      sha256: v1.slice(1, -1),
      size: policy("v1").length,
    });

    expect((await create(url, policy("again"))).status).toBe(412);
    expect((await put(url, policy("v2"), {})).status).toBe(428);

    const updated = await put(url, policy("v2"), { "If-Match": v1 });
    expect(updated.status).toBe(200);
    const stale = await put(url, policy("stale"), { "If-Match": v1 });
    expect(stale.status).toBe(412);
    expect(((await stale.json()) as { error: string }).error).toMatch(/changed since you loaded/);
    // A compressing proxy hands the browser a weak ETag.
    expect(
      (await put(url, policy("v3"), { "If-Match": `W/${updated.headers.get("ETag")}` })).status,
    ).toBe(200);
    expect((await put(url, policy("v4"), { "If-Match": "*" })).status).toBe(200);

    const current = await fetch(url);
    expect(await current.text()).toBe(policy("v4"));
    expect(current.headers.get("ETag")).toBe(etagOf(policy("v4")));
    expect(current.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("keeps each policy in its own file with its own version", async () => {
    await using server = await startServer();
    const work = (await create(server.policyUrl("work"), policy("w1"))).headers.get("ETag")!;
    const home = (await create(server.policyUrl("home"), policy("h1"))).headers.get("ETag")!;

    expect((await put(server.policyUrl("work"), policy("w2"), { "If-Match": home })).status).toBe(
      412,
    );
    expect((await put(server.policyUrl("work"), policy("w2"), { "If-Match": work })).status).toBe(
      200,
    );

    expect(await server.read("work.json")).toBe(policy("w2"));
    expect(await server.read("home.json")).toBe(policy("h1"));
    expect((await NodeFSP.readdir(server.policyDir)).toSorted()).toEqual([
      "home.json",
      "work.json",
    ]);
  });

  it("deletes only the version the caller loaded", async () => {
    await using server = await startServer();
    const url = server.policyUrl("old");
    const v1 = (await create(url, policy("v1"))).headers.get("ETag")!;
    await put(url, policy("v2"), { "If-Match": v1 });

    expect((await remove(url, {})).status).toBe(428);
    expect((await remove(url, { "If-Match": v1 })).status).toBe(412);
    expect(await server.read("old.json")).toBe(policy("v2"));

    expect((await remove(url, { "If-Match": etagOf(policy("v2")) })).status).toBe(204);
    expect((await fetch(url)).status).toBe(404);
    expect((await remove(url, { "If-Match": "*" })).status).toBe(412);
    expect(await NodeFSP.readdir(server.policyDir)).toEqual([]);
  });

  it("cleans up after a failed write, and the next write succeeds", async () => {
    await using server = await startServer({
      setup: (policyDir) => NodeFSP.writeFile(NodePath.join(policyDir, "work.json.1.tmp"), "{"),
    });
    const url = server.policyUrl("work");
    const v1 = (await create(url, policy("v1"))).headers.get("ETag")!;
    expect(await NodeFSP.readdir(server.policyDir)).toEqual(["work.json"]);

    // A dangling link where the temporary file goes makes opening it fail.
    await NodeFSP.symlink(
      NodePath.join(server.policyDir, "missing", "work.json"),
      NodePath.join(server.policyDir, `work.json.${process.pid}.tmp`),
    );
    expect((await put(url, policy("v2"), { "If-Match": v1 })).status).toBe(500);
    expect(await NodeFSP.readdir(server.policyDir)).toEqual(["work.json"]);
    expect(await (await fetch(url)).text()).toBe(policy("v1"));

    expect((await put(url, policy("v2"), { "If-Match": v1 })).status).toBe(200);
    expect(await (await fetch(url)).text()).toBe(policy("v2"));
  });

  it("lets exactly one of two concurrent changes from the same version win", async () => {
    await using server = await startServer();
    const url = server.policyUrl("work");
    const v1 = (await create(url, policy("v1"))).headers.get("ETag")!;

    const results = await Promise.all(
      ["a", "b"].map(async (organization) => {
        const response = await put(url, policy(organization), { "If-Match": v1 });
        return { organization, status: response.status };
      }),
    );
    expect(results.map((result) => result.status).toSorted()).toEqual([200, 412]);
    const winner = results.find((result) => result.status === 200)!.organization;
    expect(await (await fetch(url)).text()).toBe(policy(winner));

    const v2 = etagOf(policy(winner));
    const raced = await Promise.all([
      remove(url, { "If-Match": v2 }),
      put(url, policy("c"), { "If-Match": v2 }),
    ]);
    expect(raced.filter((response) => response.status === 412)).toHaveLength(1);
    expect(raced.filter((response) => response.ok)).toHaveLength(1);
  });

  it("refuses bodies that are not a version 1 policy, and names it cannot store", async () => {
    await using server = await startServer();
    const url = server.policyUrl("work");
    const refusals = await Promise.all(
      [
        [url, "{oops", /not valid JSON/],
        [url, "[]", /a JSON object/],
        [url, '{"schemaVersion":2,"organization":"x"}', /schemaVersion must be 1/],
        [url, '{"schemaVersion":1}', /organization must be a string/],
        [url, policy("big", `,"pad":"${"x".repeat(256 * 1024)}"`), /at most 256 KiB/],
        ...["Work", "-work", "work.json", "a_b", "x".repeat(64), "a/b", ""].map((name) => [
          server.policyUrl(name),
          policy("x"),
          /policy name/,
        ]),
      ].map(async ([target, body, message]) => {
        const response = await create(target as string, body as string);
        return {
          status: response.status,
          error: ((await response.json()) as { error: string }).error,
          message,
        };
      }),
    );
    for (const refusal of refusals) expect(refusal.error).toMatch(refusal.message as RegExp);
    expect(refusals.map((refusal) => refusal.status)).toEqual([
      400,
      400,
      400,
      400,
      413,
      ...Array(7).fill(400),
    ]);
    expect(await NodeFSP.readdir(server.policyDir)).toEqual([]);
  });
});

describe(API_PATH, () => {
  it("lists stored policies by name, skipping files that are not one", async () => {
    await using server = await startServer({
      setup: async (policyDir) => {
        for (const file of ["Upper.json", "notes.txt", "-dash.json"]) {
          await NodeFSP.writeFile(NodePath.join(policyDir, file), policy("ignored"));
        }
      },
    });
    expect(await (await fetch(`${server.origin}${API_PATH}`)).json()).toEqual({ policies: [] });
    await create(server.policyUrl("work"), policy("w"));
    await create(server.policyUrl("home"), policy("home"));

    const response = await fetch(`${server.origin}${API_PATH}`);
    const { policies } = (await response.json()) as { policies: Array<Record<string, unknown>> };
    expect(policies).toEqual([
      {
        name: "home",
        etag: etagOf(policy("home")),
        size: policy("home").length,
        modifiedAt: expect.any(String),
        publicUrl: "https://policy.example/home.json",
      },
      expect.objectContaining({ name: "work", publicUrl: "https://policy.example/work.json" }),
    ]);
    expect((await fetch(`${server.origin}${API_PATH}`, { method: "POST" })).status).toBe(405);
  });
});

describe("the single-policy layout", () => {
  it("moves policy.json to dotfiles.json, keeping its bytes", async () => {
    const raw = `{\n  "schemaVersion": 1,\n  "organization": "dotfiles"\n}\n`;
    await using server = await startServer({
      setup: (policyDir) => NodeFSP.writeFile(NodePath.join(policyDir, "policy.json"), raw),
    });
    expect(await NodeFSP.readdir(server.policyDir)).toEqual(["dotfiles.json"]);
    expect(await server.read("dotfiles.json")).toBe(raw);
    const served = await fetch(`${server.publicOrigin}/dotfiles.json`);
    expect(served.headers.get("ETag")).toBe(etagOf(raw));
    expect((await fetch(`${server.publicOrigin}/policy.json`)).status).toBe(404);
    expect((await fetch(`${server.origin}/policy.json`)).status).toBe(404);
  });

  it("leaves both files alone when dotfiles.json already exists", async () => {
    await using server = await startServer({
      setup: async (policyDir) => {
        await NodeFSP.writeFile(NodePath.join(policyDir, "policy.json"), policy("legacy"));
        await NodeFSP.writeFile(NodePath.join(policyDir, "dotfiles.json"), policy("current"));
      },
    });
    expect(await server.read("policy.json")).toBe(policy("legacy"));
    expect(await server.read("dotfiles.json")).toBe(policy("current"));
  });
});

describe("the public listener", () => {
  it("serves a policy by name with the sha256 of its bytes as ETag, and 304 when unchanged", async () => {
    await using server = await startServer();
    const raw = policy("dotfiles");
    await create(server.policyUrl("dotfiles"), raw);
    const url = `${server.publicOrigin}/dotfiles.json`;

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(raw);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("ETag")).toBe(`"${sha256(raw)}"`);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");

    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("ETag")).toBe(etagOf(raw));

    for (const ifNoneMatch of [etagOf(raw), `W/${etagOf(raw)}`, `"other", ${etagOf(raw)}`, "*"]) {
      const cached = await fetch(url, { headers: { "If-None-Match": ifNoneMatch } });
      expect(cached.status).toBe(304);
      expect(cached.headers.get("ETag")).toBe(etagOf(raw));
    }
    expect((await fetch(url, { headers: { "If-None-Match": '"other"' } })).status).toBe(200);
    expect((await fetch(`${server.publicOrigin}/healthz`)).status).toBe(200);
  });

  it("offers no way to write, list, or reach anything but a named policy", async () => {
    await using server = await startServer();
    const raw = policy("dotfiles");
    await create(server.policyUrl("dotfiles"), raw);
    const at = (path: string) => `${server.publicOrigin}${path}`;

    for (const method of ["PUT", "POST", "DELETE", "PATCH"]) {
      for (const path of ["/dotfiles.json", "/fresh.json", `${API_PATH}/dotfiles`, "/"]) {
        const response = await fetch(at(path), {
          method,
          body: method === "DELETE" ? null : policy("evil"),
          headers: { "If-Match": "*", "If-None-Match": "*" },
        });
        expect({ method, path, status: response.status }).toEqual({ method, path, status: 405 });
      }
    }
    for (const path of [
      "/missing.json",
      "/Dotfiles.json",
      "/-x.json",
      "/dotfiles",
      "/dotfiles.json/",
      "/%64otfiles.json",
      "/..%2Fdotfiles.json",
      "/",
      "/index.html",
      API_PATH,
      `${API_PATH}/dotfiles`,
    ]) {
      expect({ path, status: (await fetch(at(path))).status }).toEqual({ path, status: 404 });
    }
    expect(await NodeFSP.readdir(server.policyDir)).toEqual(["dotfiles.json"]);
    expect(await server.read("dotfiles.json")).toBe(raw);
  });
});

describe("/healthz", () => {
  it("reports whether POLICY_DIR is a writable directory", async () => {
    await using writable = await startServer();
    expect((await fetch(`${writable.origin}/healthz`)).status).toBe(200);

    for (const breakIt of [
      (policyDir: string) => NodeFSP.rm(policyDir, { recursive: true }),
      async (policyDir: string) => {
        await NodeFSP.rm(policyDir, { recursive: true });
        await NodeFSP.writeFile(policyDir, "");
      },
    ]) {
      await using broken = await startServer();
      await breakIt(broken.policyDir);
      const response = await fetch(`${broken.origin}/healthz`);
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toMatch(/POLICY_DIR/);
      const publicResponse = await fetch(`${broken.publicOrigin}/healthz`);
      expect(publicResponse.status).toBe(503);
      expect(await publicResponse.text()).not.toMatch(broken.policyDir);
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
    for (const origin of [server.origin, server.publicOrigin]) {
      // fetch would normalize this URL, so send the raw request line.
      const status = await new Promise<number | undefined>((resolve, reject) => {
        NodeHttp.get(`${origin}/`, { path: "//[" }, (response) => {
          response.resume();
          resolve(response.statusCode);
        }).on("error", reject);
      });
      expect(status).toBe(400);
      expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    }
  });
});
