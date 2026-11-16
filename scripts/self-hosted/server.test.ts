// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercises the Node-only server over real HTTP, as a browser would.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeZlib from "node:zlib";

import * as SharedDevUpdates from "@t3tools/shared/devUpdates";
import { afterEach, describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  type AccessVerifier,
  createSelfHostedServer,
  DEV_UPDATES_CHANNEL,
  DEV_UPDATES_HUB_PATH,
  DEV_UPDATES_MANIFEST_URL,
  type DevBundleStore,
  type DevUpdatesState,
  makeCloudflareAccessVerifier,
  makeDevBundleStore,
  SHARED_CATALOG_PATH,
} from "./server.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startServer(
  input: { historyLimit?: number; access?: AccessVerifier; devBundles?: DevBundleStore } = {},
) {
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
    devBundles: input.devBundles,
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

describe("dev updates", () => {
  const signingKeys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const otherKeys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const release = "1.2.80";
  const assetUrl = (id: string) => `https://ota.test/t3code/assets/${id}.tgz`;

  function tarGz(entries: Record<string, string>) {
    const blocks: Buffer[] = [];
    for (const [name, content] of Object.entries(entries)) {
      const directory = name.endsWith("/");
      const data = Buffer.from(directory ? "" : content);
      if (name.length > 100) {
        const longName = Buffer.from(`${name}\0`);
        const record = Buffer.alloc(512);
        record.write("././@LongLink", 0, 100);
        record.write(`${longName.length.toString(8).padStart(11, "0")}\0`, 124);
        record.write("L", 156);
        blocks.push(record, longName, Buffer.alloc((512 - (longName.length % 512)) % 512));
      }
      const header = Buffer.alloc(512);
      header.write(name.slice(0, 100), 0, 100);
      header.write("0000755\0", 100);
      header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
      header.write(directory ? "5" : "0", 156);
      header.write("ustar\u000000", 257);
      blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    return NodeZlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  }

  const goodArchive = (html: string) =>
    tarGz({ "./": "", "./index.html": html, "./assets/": "", "./assets/dev-1.js": "dev chunk" });

  function signature(body: Buffer, key = signingKeys.privateKey) {
    const sig = NodeCrypto.sign("RSA-SHA256", body, key).toString("base64");
    return `sig="${sig}", keyid="main", alg="rsa-v1_5-sha256"`;
  }

  function multipart(name: "manifest" | "directive", body: Buffer, expoSignature?: string) {
    const boundary = "test-boundary";
    const headers = [
      "content-type: application/json; charset=utf-8",
      `content-disposition: form-data; name="${name}"`,
      ...(expoSignature === undefined ? [] : [`expo-signature: ${expoSignature}`]),
    ];
    return new Response(
      Buffer.concat([
        Buffer.from(`--${boundary}\r\n${headers.join("\r\n")}\r\n\r\n`),
        body,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      { headers: { "content-type": `multipart/mixed; boundary=${boundary}` } },
    );
  }

  function manifestFor(id: string, archive: Buffer, overrides: Record<string, unknown> = {}) {
    return Buffer.from(
      JSON.stringify({
        id,
        createdAt: "2026-11-15T00:00:00.000Z",
        runtimeVersion: release,
        launchAsset: {
          hash: NodeCrypto.createHash("sha256").update(archive).digest("base64url"),
          key: "bundle",
          contentType: "application/gzip",
          url: assetUrl(id),
        },
        assets: [],
        metadata: { gitCommit: `${id}0000000000` },
        extra: {},
        ...overrides,
      }),
    );
  }

  /** A fake OTA server whose next manifest response the test sets. */
  async function makeOta(input: { release?: string; directory?: string } = {}) {
    const directory =
      input.directory ?? (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dev-updates-")));
    if (input.directory === undefined) {
      cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
    const ota = {
      manifest: (): Response => new Response(null, { status: 204 }),
      archives: new Map<string, Buffer>(),
      manifestRequests: [] as Array<Headers>,
    };
    const store = makeDevBundleStore({
      release: input.release ?? release,
      directory,
      verificationKey: signingKeys.publicKey,
      fetch: async (url, init) => {
        if (url === DEV_UPDATES_MANIFEST_URL) {
          ota.manifestRequests.push(new Headers(init?.headers));
          return ota.manifest();
        }
        const archive = [...ota.archives].find(([id]) => url === assetUrl(id))?.[1];
        return archive ? new Response(archive) : new Response(null, { status: 404 });
      },
    });
    const publish = (id: string, archive: Buffer, overrides?: Record<string, unknown>) => {
      ota.archives.set(id, archive);
      const body = manifestFor(id, archive, overrides);
      ota.manifest = () => multipart("manifest", body, signature(body));
    };
    return { ota, store, directory, publish };
  }

  const devCookie = { Cookie: "theme=dark; t3_dev_updates=1" };

  it("mirrors the shared client contract", () => {
    expect([DEV_UPDATES_HUB_PATH, DEV_UPDATES_MANIFEST_URL, DEV_UPDATES_CHANNEL]).toEqual([
      SharedDevUpdates.DEV_UPDATES_HUB_PATH,
      SharedDevUpdates.DEV_UPDATES_MANIFEST_URL,
      SharedDevUpdates.DEV_UPDATES_CHANNEL,
    ]);
    expectTypeOf<DevUpdatesState>().toEqualTypeOf<SharedDevUpdates.DevUpdatesState>();
  });

  it("installs a signed bundle and serves it only to browsers that opted in", async () => {
    const { ota, store, publish } = await makeOta();
    publish("update-1", goodArchive("<dev-shell>"));
    await store.refresh();

    expect(Object.fromEntries(ota.manifestRequests[0]!)).toMatchObject({
      "expo-platform": "web",
      "expo-runtime-version": release,
      "expo-channel-name": "dev",
      "expo-protocol-version": "1",
    });
    const { origin } = await startServer({ devBundles: store });
    const dev = await fetch(`${origin}/settings`, { headers: devCookie });
    expect(await dev.text()).toBe("<dev-shell>");
    expect(dev.headers.get("Cache-Control")).toBe("no-store");
    expect(dev.headers.get("Vary")).toBe("Cookie");
    const release_ = await fetch(`${origin}/`);
    expect(await release_.text()).toBe("<app-shell>");
    expect(release_.headers.get("Cache-Control")).toBe("no-store");
    expect(release_.headers.get("Vary")).toBe("Cookie");

    // A page from either bundle still finds its own chunks after switching.
    expect(await (await fetch(`${origin}/assets/dev-1.js`)).text()).toBe("dev chunk");
    const releaseChunk = await fetch(`${origin}/assets/app-abc.js`, { headers: devCookie });
    expect(await releaseChunk.text()).toBe("bundle");
    expect(releaseChunk.headers.get("Cache-Control")).toContain("immutable");
  });

  it("unpacks large files and long names intact", async () => {
    const { store, directory, publish } = await makeOta();
    const chunk = Array.from({ length: 200_000 }, (_, i) => "abcdefghij"[(i * 7) % 10]).join("");
    const longName = `./assets/${"nested/".repeat(20)}chunk.js`;
    publish("update-1", tarGz({ "./index.html": "<dev-shell>", [longName]: chunk }));
    await store.refresh();

    expect(store.current()?.bundle.updateId).toBe("update-1");
    const unpacked = NodePath.join(directory, "bundles", "update-1", longName);
    expect(await NodeFSP.readFile(unpacked, "utf8")).toBe(chunk);
  });

  it("reports and sets this browser's choice", async () => {
    const { store, publish } = await makeOta();
    publish("update-1", goodArchive("<dev-shell>"));
    await store.refresh();
    const { origin } = await startServer({ devBundles: store });
    const endpoint = `${origin}${DEV_UPDATES_HUB_PATH}`;
    const post = (body: string, contentType = "application/json") =>
      fetch(endpoint, { method: "POST", body, headers: { "Content-Type": contentType } });
    const running = {
      updateId: "update-1",
      commit: "update-10000000000",
      createdAt: "2026-11-15T00:00:00.000Z",
    };

    const off = await fetch(endpoint);
    expect(off.headers.get("Cache-Control")).toBe("no-store");
    expect(await off.json()).toEqual({
      enabled: false,
      runtimeVersion: release,
      running: null,
      pending: null,
    });
    expect(await (await fetch(endpoint, { headers: devCookie })).json()).toEqual({
      enabled: true,
      runtimeVersion: release,
      running,
      pending: null,
    });

    const enabled = await post('{"enabled":true}');
    expect(await enabled.json()).toMatchObject({ enabled: true, running });
    expect(enabled.headers.get("Set-Cookie")).toMatch(
      /^t3_dev_updates=1; Max-Age=\d+; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
    );
    const disabled = await post('{"enabled":false}');
    expect(await disabled.json()).toMatchObject({ enabled: false, running: null });
    expect(disabled.headers.get("Set-Cookie")).toMatch(/^t3_dev_updates=; Max-Age=0; /);

    expect((await post('{"enabled":"yes"}')).status).toBe(400);
    expect((await post("enabled=true", "application/x-www-form-urlencoded")).status).toBe(415);
  });

  it("answers 404 and serves the release bundle when the lane is off", async () => {
    const { origin } = await startServer();
    expect((await fetch(`${origin}${DEV_UPDATES_HUB_PATH}`)).status).toBe(404);
    expect(await (await fetch(`${origin}/`, { headers: devCookie })).text()).toBe("<app-shell>");
  });

  it("serves the release bundle to opted-in browsers until a dev bundle exists", async () => {
    const { store } = await makeOta();
    await store.refresh();
    const { origin } = await startServer({ devBundles: store });
    expect(await (await fetch(`${origin}/`, { headers: devCookie })).text()).toBe("<app-shell>");
    expect(
      await (await fetch(`${origin}${DEV_UPDATES_HUB_PATH}`, { headers: devCookie })).json(),
    ).toMatchObject({ enabled: true, running: null });
  });

  it.each<[string, (ota: Awaited<ReturnType<typeof makeOta>>) => void]>([
    [
      "an unsigned manifest",
      ({ ota }) => {
        const body = manifestFor("bad", goodArchive("<bad>"));
        ota.archives.set("bad", goodArchive("<bad>"));
        ota.manifest = () => multipart("manifest", body);
      },
    ],
    [
      "a manifest signed by another key",
      ({ ota }) => {
        const body = manifestFor("bad", goodArchive("<bad>"));
        ota.archives.set("bad", goodArchive("<bad>"));
        ota.manifest = () => multipart("manifest", body, signature(body, otherKeys.privateKey));
      },
    ],
    [
      "a manifest changed after signing",
      ({ ota }) => {
        const signed = manifestFor("bad", goodArchive("<bad>"));
        const tampered = manifestFor("bad", goodArchive("<evil>"));
        ota.archives.set("bad", goodArchive("<evil>"));
        ota.manifest = () => multipart("manifest", tampered, signature(signed));
      },
    ],
    [
      "an archive that does not match its hash",
      ({ ota, publish }) => {
        publish("bad", goodArchive("<bad>"));
        ota.archives.set("bad", goodArchive("<swapped>"));
      },
    ],
    [
      "a manifest for another release",
      ({ publish }) => publish("bad", goodArchive("<bad>"), { runtimeVersion: "1.2.79" }),
    ],
    [
      "an archive that writes outside its directory",
      ({ publish }) => publish("bad", tarGz({ "./index.html": "<bad>", "../escape.txt": "x" })),
    ],
    ["an archive without an app shell", ({ publish }) => publish("bad", tarGz({ "a.txt": "x" }))],
    [
      "an archive that ends inside an entry",
      ({ publish }) =>
        publish(
          "bad",
          NodeZlib.gzipSync(NodeZlib.gunzipSync(goodArchive("<bad>")).subarray(0, 1027)),
        ),
    ],
    [
      "an unsigned rollback directive",
      ({ ota }) => {
        const body = Buffer.from('{"type":"rollBackToEmbedded"}');
        ota.manifest = () => multipart("directive", body);
      },
    ],
    [
      "an OTA server error",
      ({ ota }) => (ota.manifest = () => new Response(null, { status: 502 })),
    ],
  ])("keeps the current bundle when given %s", async (_label, serve) => {
    const ota = await makeOta();
    ota.publish("good", goodArchive("<good>"));
    await ota.store.refresh();

    serve(ota);
    await ota.store.refresh();

    expect(ota.store.current()?.bundle.updateId).toBe("good");
    expect(await NodeFSP.readdir(NodePath.join(ota.directory, "bundles"))).toEqual(["good"]);
  });

  it.each(["rollBackToEmbedded", "noUpdateAvailable"])(
    "drops the dev bundle on a signed %s directive",
    async (type) => {
      const { ota, store, directory, publish } = await makeOta();
      publish("good", goodArchive("<good>"));
      await store.refresh();

      const body = Buffer.from(JSON.stringify({ type }));
      ota.manifest = () => multipart("directive", body, signature(body));
      await store.refresh();

      expect(store.current()).toBeNull();
      expect(await NodeFSP.readdir(NodePath.join(directory, "bundles"))).toEqual([]);
    },
  );

  it("replaces the bundle with a newer one and restores it after a restart of the same release", async () => {
    const first = await makeOta();
    first.publish("update-1", goodArchive("<one>"));
    await first.store.refresh();
    first.publish("update-2", goodArchive("<two>"));
    await first.store.refresh();
    expect(await NodeFSP.readdir(NodePath.join(first.directory, "bundles"))).toEqual(["update-2"]);

    const restarted = await makeOta({ directory: first.directory });
    await restarted.store.load();
    expect(restarted.store.current()?.bundle.updateId).toBe("update-2");

    const upgraded = await makeOta({ directory: first.directory, release: "1.2.81" });
    await upgraded.store.load();
    expect(upgraded.store.current()).toBeNull();
  });
});
