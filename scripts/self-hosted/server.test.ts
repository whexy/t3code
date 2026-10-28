// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercises the Node-only server over real HTTP, as a browser would.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  type AccessVerifier,
  createSelfHostedServer,
  makeCloudflareAccessVerifier,
  SHARED_CATALOG_PATH,
} from "./server.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startServer(input: { historyLimit?: number; access?: AccessVerifier } = {}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-self-hosted-"));
  const webRoot = NodePath.join(directory, "web");
  const catalogDir = NodePath.join(directory, "catalog");
  await NodeFSP.mkdir(NodePath.join(webRoot, "assets"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(webRoot, "index.html"), "<app-shell>");
  await NodeFSP.writeFile(NodePath.join(webRoot, "assets", "app-abc.js"), "bundle");
  await NodeFSP.writeFile(NodePath.join(directory, "secret.txt"), "outside");

  const server = createSelfHostedServer({
    webRoot,
    catalogDir,
    historyLimit: input.historyLimit ?? 100,
    access: input.access ?? (async () => true),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  return { origin, catalogDir, catalogUrl: `${origin}${SHARED_CATALOG_PATH}` };
}

const put = (url: string, body: string, headers: Record<string, string>) =>
  fetch(url, { method: "PUT", body, headers });

describe("shared catalog", () => {
  it("creates once, then only accepts writes based on the current version", async () => {
    const { catalogUrl } = await startServer();

    expect((await fetch(catalogUrl)).status).toBe(404);
    const created = await put(catalogUrl, '{"v":1}', { "If-None-Match": "*" });
    expect(created.status).toBe(201);
    expect((await put(catalogUrl, '{"v":1}', { "If-None-Match": "*" })).status).toBe(412);
    expect((await put(catalogUrl, '{"v":2}', {})).status).toBe(428);

    const v1 = created.headers.get("ETag")!;
    const updated = await put(catalogUrl, '{"v":2}', { "If-Match": v1 });
    expect(updated.status).toBe(200);
    expect((await put(catalogUrl, '{"stale":true}', { "If-Match": v1 })).status).toBe(412);

    const current = await fetch(catalogUrl);
    expect(await current.text()).toBe('{"v":2}');
    expect(current.headers.get("ETag")).toBe(updated.headers.get("ETag"));
  });

  it("accepts the weak ETag a compressing proxy hands the browser", async () => {
    const { catalogUrl } = await startServer();
    const v1 = (await put(catalogUrl, '{"v":1}', { "If-None-Match": "*" })).headers.get("ETag")!;

    expect((await put(catalogUrl, '{"v":2}', { "If-Match": `W/${v1}` })).status).toBe(200);
    expect((await put(catalogUrl, '{"v":3}', { "If-Match": `W/${v1}` })).status).toBe(412);
  });

  it("lets exactly one of two concurrent saves from the same version win", async () => {
    const { catalogUrl } = await startServer();
    const v1 = (await put(catalogUrl, "{}", { "If-None-Match": "*" })).headers.get("ETag")!;

    const statuses = await Promise.all(
      ['{"a":1}', '{"b":1}'].map(
        async (body) => (await put(catalogUrl, body, { "If-Match": v1 })).status,
      ),
    );

    expect(statuses.toSorted()).toEqual([200, 412]);
  });

  it("keeps the newest versions in history", async () => {
    const { catalogUrl, catalogDir } = await startServer({ historyLimit: 2 });
    let etag = (await put(catalogUrl, '{"v":1}', { "If-None-Match": "*" })).headers.get("ETag")!;
    for (const version of [2, 3]) {
      etag = (await put(catalogUrl, `{"v":${version}}`, { "If-Match": etag })).headers.get("ETag")!;
    }

    const historyDir = NodePath.join(catalogDir, "history");
    const versions = await Promise.all(
      (await NodeFSP.readdir(historyDir))
        .toSorted()
        .map((name) => NodeFSP.readFile(NodePath.join(historyDir, name), "utf8")),
    );
    expect(versions).toEqual(['{"v":2}', '{"v":3}']);
  });

  it("rejects bodies that are not JSON", async () => {
    const { catalogUrl } = await startServer();
    expect((await put(catalogUrl, "{oops", { "If-None-Match": "*" })).status).toBe(400);
    expect((await fetch(catalogUrl)).status).toBe(404);
  });
});

describe("static web app", () => {
  it("serves assets and falls back to the app shell without leaving the web root", async () => {
    const { origin } = await startServer();

    const asset = await fetch(`${origin}/assets/app-abc.js`);
    expect(await asset.text()).toBe("bundle");
    expect(asset.headers.get("Cache-Control")).toContain("immutable");

    expect(await (await fetch(`${origin}/settings/connections`)).text()).toBe("<app-shell>");
    expect(await (await fetch(`${origin}/..%2fsecret.txt`)).text()).toBe("<app-shell>");
  });
});

describe("Cloudflare Access verification", () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1" };
  const now = Date.UTC(2026, 0, 1);

  function sign(claims: Record<string, unknown>, kid = "key-1") {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", kid })}.${encode(claims)}`;
    const signature = NodeCrypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
    return `${unsigned}.${signature.toString("base64url")}`;
  }

  const verify = makeCloudflareAccessVerifier({
    teamDomain: "team.cloudflareaccess.com",
    audience: "app-aud",
    fetchKeys: async () => [jwk],
    now: () => now,
  });
  const requestWith = (token?: string) =>
    ({
      headers: token === undefined ? {} : { "cf-access-jwt-assertion": token },
    }) as NodeHttp.IncomingMessage;
  const valid = {
    iss: "https://team.cloudflareaccess.com",
    aud: ["app-aud"],
    exp: now / 1000 + 60,
  };

  it("accepts a current token for this application", async () => {
    expect(await verify(requestWith(sign(valid)))).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["expired", sign({ ...valid, exp: now / 1000 - 1 })],
    ["for another application", sign({ ...valid, aud: ["other-aud"] })],
    ["from another team", sign({ ...valid, iss: "https://other.cloudflareaccess.com" })],
    ["signed by an unknown key", sign(valid, "key-2")],
    [
      "tampered",
      sign(valid).replace(
        /\.[^.]+\./,
        `.${Buffer.from(JSON.stringify({ ...valid, aud: "x" })).toString("base64url")}.`,
      ),
    ],
  ])("rejects a %s token", async (_label, token) => {
    expect(await verify(requestWith(token))).toBe(false);
  });

  it("guards the catalog when configured", async () => {
    const { catalogUrl } = await startServer({ access: verify });
    expect((await fetch(catalogUrl)).status).toBe(403);
    expect(
      (await fetch(catalogUrl, { headers: { "Cf-Access-Jwt-Assertion": sign(valid) } })).status,
    ).toBe(404);
  });
});
