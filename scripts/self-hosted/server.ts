#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - Runs alone in a Node-only image, without workspace dependencies.
/**
 * The web hub: a hosted web build, one shared connection catalog, and, with
 * `T3CODE_RELEASE` set, the dev OTA lane's bundle for browsers that opt in. The
 * catalog holds bearer tokens for every paired environment: keep it behind Access.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import type * as NodeStreamWeb from "node:stream/web";
import * as NodeZlib from "node:zlib";

export const SHARED_CATALOG_PATH = "/__t3code/shared-catalog";
// Mirrors `@t3tools/shared/devUpdates`, which this image cannot import; server.test.ts keeps them equal.
export const DEV_UPDATES_HUB_PATH = "/__t3code/dev-updates";
export const DEV_UPDATES_MANIFEST_URL = "https://ota.clusters.work/t3code/manifest";
export const DEV_UPDATES_CHANNEL = "dev";
const DEV_UPDATES_COOKIE = "t3_dev_updates";
const DEV_UPDATES_POLL_MS = 5 * 60 * 1000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export interface SelfHostedServerOptions {
  readonly webRoot: string;
  readonly catalogDir: string;
  readonly historyLimit: number;
  readonly access: AccessVerifier;
  /** Absent when the dev lane is off: the dev-updates endpoint then answers 404. */
  readonly devBundles?: DevBundleStore | undefined;
}

export type AccessVerifier = (request: NodeHttp.IncomingMessage) => Promise<boolean>;

export function createSelfHostedServer(options: SelfHostedServerOptions): NodeHttp.Server {
  const catalog = makeCatalogFile(options.catalogDir, options.historyLimit);
  return NodeHttp.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const devRoot = options.devBundles?.current()?.root;
    const roots =
      devRoot === undefined
        ? [options.webRoot]
        : hasDevUpdatesCookie(request)
          ? [devRoot, options.webRoot]
          : [options.webRoot, devRoot];
    const handled =
      pathname === SHARED_CATALOG_PATH
        ? handleCatalog(request, response, catalog, options.access)
        : pathname === DEV_UPDATES_HUB_PATH
          ? handleDevUpdates(request, response, options.devBundles)
          : serveStatic(request, response, roots, pathname);
    handled.catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
}

async function handleCatalog(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  catalog: CatalogFile,
  access: AccessVerifier,
) {
  response.setHeader("Cache-Control", "no-store");
  if (!(await access(request))) {
    response.writeHead(403).end();
    return;
  }
  if (request.method === "GET") {
    const current = await catalog.read();
    if (current === null) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "Content-Type": "application/json", ETag: current.etag })
      .end(current.raw);
    return;
  }
  if (request.method !== "PUT") {
    response.writeHead(405, { Allow: "GET, PUT" }).end();
    return;
  }

  // Cloudflare weakens the ETag when it compresses the GET response. The tag is
  // a hash of the stored bytes, so its weak form still names exactly one version.
  const ifMatch = request.headers["if-match"]?.replace(/^W\//, "") ?? null;
  const createOnly = request.headers["if-none-match"] === "*";
  if (ifMatch === null && !createOnly) {
    response.writeHead(428).end();
    return;
  }
  const raw = await readBody(request);
  if (raw === null) {
    response.writeHead(413).end();
    return;
  }
  try {
    JSON.parse(raw);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const result = await catalog.write(raw, createOnly ? null : ifMatch);
  if (result === null) {
    response.writeHead(412).end();
    return;
  }
  response.writeHead(createOnly ? 201 : 200, { ETag: result }).end();
}

async function readBody(request: NodeHttp.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_CATALOG_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface CatalogFile {
  readonly read: () => Promise<{ raw: string; etag: string } | null>;
  /** Returns the new ETag, or null when `expectedEtag` no longer matches. */
  readonly write: (raw: string, expectedEtag: string | null) => Promise<string | null>;
}

function etagOf(raw: string) {
  return `"${NodeCrypto.createHash("sha256").update(raw).digest("base64url")}"`;
}

function makeCatalogFile(directory: string, historyLimit: number): CatalogFile {
  const currentPath = NodePath.join(directory, "catalog.json");
  // Every accepted write stays here; to roll back, copy one over catalog.json.
  const historyDir = NodePath.join(directory, "history");
  // Serializes read-compare-write so two saves can never both match one ETag.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(task: () => Promise<A>): Promise<A> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const read = async () => {
    try {
      const raw = await NodeFSP.readFile(currentPath, "utf8");
      return { raw, etag: etagOf(raw) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const write = (raw: string, expectedEtag: string | null) =>
    exclusive(async () => {
      const current = await read();
      if ((current?.etag ?? null) !== expectedEtag) return null;

      await NodeFSP.mkdir(historyDir, { recursive: true });
      const stamp = new Date().toISOString().replaceAll(":", "-");
      const version = `${stamp}-${etagOf(raw).slice(1, 9)}.json`;
      await NodeFSP.writeFile(NodePath.join(historyDir, version), raw, { mode: 0o600 });
      const temporaryPath = `${currentPath}.${process.pid}.tmp`;
      await NodeFSP.writeFile(temporaryPath, raw, { mode: 0o600 });
      await NodeFSP.rename(temporaryPath, currentPath);

      const versions = (await NodeFSP.readdir(historyDir)).toSorted();
      await Promise.all(
        versions
          .slice(0, Math.max(0, versions.length - historyLimit))
          .map((name) => NodeFSP.rm(NodePath.join(historyDir, name), { force: true })),
      );
      return etagOf(raw);
    });

  return { read, write };
}

/**
 * Serves from the first root that has the file, so a page loaded from one bundle
 * still finds its lazy chunks after the browser switches to the other.
 */
async function serveStatic(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  roots: ReadonlyArray<string>,
  pathname: string,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let root = NodePath.resolve(roots[0]!);
  // Client-side routes resolve to the app shell.
  let filePath = NodePath.join(root, "index.html");
  for (const candidateRoot of roots.map((path) => NodePath.resolve(path))) {
    const candidate = NodePath.resolve(candidateRoot, `.${decodeURIComponent(pathname)}`);
    if (candidate.startsWith(`${candidateRoot}${NodePath.sep}`) && (await isFile(candidate))) {
      root = candidateRoot;
      filePath = candidate;
      break;
    }
  }
  const body = await NodeFSP.readFile(filePath);
  const extension = NodePath.extname(filePath).toLowerCase();
  const hashedAsset = filePath.startsWith(NodePath.join(root, "assets") + NodePath.sep);
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
    // The app shell names a different bundle per dev-updates cookie, so no cache may keep it.
    "Cache-Control": hashedAsset
      ? "public, max-age=31536000, immutable"
      : extension === ".html"
        ? "no-store"
        : "no-cache",
    ...(hashedAsset ? {} : { Vary: "Cookie" }),
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

async function isFile(path: string) {
  try {
    return (await NodeFSP.stat(path)).isFile();
  } catch {
    return false;
  }
}

interface DevBundle {
  readonly updateId: string;
  readonly commit: string | null;
  readonly createdAt: string;
}

/** Mirrors `DevUpdatesState` from `@t3tools/shared/devUpdates`. */
export interface DevUpdatesState {
  readonly enabled: boolean;
  readonly runtimeVersion: string;
  readonly running: DevBundle | null;
  readonly pending: DevBundle | null;
}

export interface DevBundleStore {
  readonly release: string;
  readonly current: () => { readonly root: string; readonly bundle: DevBundle } | null;
  /** Restores the bundle a previous run installed for this release. */
  readonly load: () => Promise<void>;
  /** Asks the OTA server for the newest dev bundle and installs it, keeping the current one on failure. */
  readonly refresh: () => Promise<void>;
}

function hasDevUpdatesCookie(request: NodeHttp.IncomingMessage) {
  return (request.headers.cookie ?? "")
    .split(";")
    .some((pair) => pair.trim() === `${DEV_UPDATES_COOKIE}=1`);
}

async function handleDevUpdates(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  devBundles: DevBundleStore | undefined,
) {
  response.setHeader("Cache-Control", "no-store");
  if (devBundles === undefined) {
    response.writeHead(404).end();
    return;
  }
  const stateFor = (enabled: boolean): DevUpdatesState => ({
    enabled,
    runtimeVersion: devBundles.release,
    running: enabled ? (devBundles.current()?.bundle ?? null) : null,
    pending: null,
  });
  if (request.method === "GET") {
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(stateFor(hasDevUpdatesCookie(request))));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "GET, POST" }).end();
    return;
  }
  // A cross-site form cannot send JSON without a CORS preflight, which this server never grants.
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    response.writeHead(415).end();
    return;
  }
  let enabled: unknown;
  try {
    enabled = (JSON.parse((await readBody(request)) ?? "") as { enabled?: unknown }).enabled;
  } catch {
    enabled = undefined;
  }
  if (typeof enabled !== "boolean") {
    response.writeHead(400).end();
    return;
  }
  const attributes = "Path=/; Secure; HttpOnly; SameSite=Lax";
  response
    .writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": enabled
        ? `${DEV_UPDATES_COOKIE}=1; Max-Age=${400 * 24 * 60 * 60}; ${attributes}`
        : `${DEV_UPDATES_COOKIE}=; Max-Age=0; ${attributes}`,
    })
    .end(JSON.stringify(stateFor(enabled)));
}

interface ManifestAsset {
  readonly hash: string;
  readonly url: string;
}

interface DevManifest {
  readonly id: string;
  readonly createdAt: string;
  readonly runtimeVersion: string;
  readonly launchAsset: ManifestAsset;
  readonly metadata?: { readonly gitCommit?: string };
}

interface InstalledBundle {
  readonly runtimeVersion: string;
  readonly bundle: DevBundle;
}

/**
 * Installs dev-channel web bundles from an expo-updates (protocol 1) server.
 * Every manifest and directive must carry a valid `expo-signature`, and the
 * archive must match the signed hash, before anything changes on disk.
 */
export function makeDevBundleStore(input: {
  readonly release: string;
  readonly directory: string;
  readonly verificationKey: NodeCrypto.KeyObject;
  readonly manifestUrl?: string;
  readonly fetch?: typeof fetch;
}): DevBundleStore {
  const fetchOta = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const bundlesDir = NodePath.join(input.directory, "bundles");
  const currentPath = NodePath.join(input.directory, "current.json");
  let current: InstalledBundle | null = null;
  let running: Promise<void> = Promise.resolve();

  const bundleRoot = (updateId: string) => NodePath.join(bundlesDir, updateId);

  const removeOtherBundles = async (keep: string | null) => {
    const names = await NodeFSP.readdir(bundlesDir).catch(() => []);
    await Promise.all(
      names
        .filter((name) => name !== keep)
        .map((name) =>
          NodeFSP.rm(NodePath.join(bundlesDir, name), { recursive: true, force: true }),
        ),
    );
  };

  const install = async (manifest: DevManifest) => {
    if (manifest.runtimeVersion !== input.release) {
      throw new Error(`manifest is for release ${manifest.runtimeVersion}`);
    }
    if (!/^[\w-]+$/.test(manifest.id)) throw new Error("manifest id is not a plain name");
    if (current?.bundle.updateId === manifest.id) return;

    const response = await fetchOta(manifest.launchAsset.url, {
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    if (!response.ok || !response.body) throw new Error(`bundle download: HTTP ${response.status}`);

    const staging = NodePath.join(bundlesDir, `.${manifest.id}.${process.pid}.partial`);
    const archive = `${staging}.tgz`;
    await NodeFSP.rm(staging, { recursive: true, force: true });
    await NodeFSP.mkdir(bundlesDir, { recursive: true });
    try {
      // The pod's memory limit is far below a bundle's unpacked size, so it streams through disk.
      const hasher = NodeCrypto.createHash("sha256");
      await NodeStreamPromises.pipeline(
        NodeStream.Readable.fromWeb(response.body as NodeStreamWeb.ReadableStream<Uint8Array>),
        new NodeStream.Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hasher.update(chunk);
            callback(null, chunk);
          },
        }),
        NodeFS.createWriteStream(archive),
      );
      if (hasher.digest("base64url") !== manifest.launchAsset.hash) {
        throw new Error("bundle does not match its hash");
      }
      await extractTarGz(archive, staging);
      if (!(await isFile(NodePath.join(staging, "index.html")))) {
        throw new Error("bundle has no index.html at its root");
      }
      await NodeFSP.rm(bundleRoot(manifest.id), { recursive: true, force: true });
      await NodeFSP.rename(staging, bundleRoot(manifest.id));
    } catch (error) {
      await NodeFSP.rm(staging, { recursive: true, force: true });
      throw error;
    } finally {
      await NodeFSP.rm(archive, { force: true });
    }
    const installed: InstalledBundle = {
      runtimeVersion: manifest.runtimeVersion,
      bundle: {
        updateId: manifest.id,
        commit: manifest.metadata?.gitCommit ?? null,
        createdAt: manifest.createdAt,
      },
    };
    await writeFileAtomically(currentPath, JSON.stringify(installed));
    current = installed;
    await removeOtherBundles(manifest.id);
  };

  const uninstall = async () => {
    current = null;
    await NodeFSP.rm(currentPath, { force: true });
    await removeOtherBundles(null);
  };

  const poll = async () => {
    const response = await fetchOta(input.manifestUrl ?? DEV_UPDATES_MANIFEST_URL, {
      headers: {
        accept: "multipart/mixed",
        "expo-platform": "web",
        "expo-runtime-version": input.release,
        "expo-channel-name": DEV_UPDATES_CHANNEL,
        "expo-protocol-version": "1",
        "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
      },
      signal: AbortSignal.timeout(60 * 1000),
    });
    // Protocol 1 answers 204 when the channel has nothing for this release.
    if (response.status === 204) return uninstall();
    if (!response.ok) throw new Error(`manifest: HTTP ${response.status}`);
    const boundary = /boundary="?([^";]+)"?/.exec(response.headers.get("content-type") ?? "")?.[1];
    if (boundary === undefined) throw new Error("manifest response is not multipart");
    const parts = parseMultipart(Buffer.from(await response.arrayBuffer()), boundary);
    const part = parts.find(({ name }) => name === "manifest" || name === "directive");
    if (part === undefined) throw new Error("manifest response has no manifest or directive");
    verifyExpoSignature(part.body, part.headers["expo-signature"], input.verificationKey);
    const body = JSON.parse(part.body.toString("utf8")) as unknown;
    if (part.name === "manifest") return install(body as DevManifest);
    const directive = (body as { type?: unknown }).type;
    if (directive === "rollBackToEmbedded" || directive === "noUpdateAvailable") return uninstall();
    throw new Error(`unknown directive ${String(directive)}`);
  };

  return {
    release: input.release,
    current: () =>
      current ? { root: bundleRoot(current.bundle.updateId), bundle: current.bundle } : null,
    load: async () => {
      try {
        const saved = JSON.parse(await NodeFSP.readFile(currentPath, "utf8")) as InstalledBundle;
        // A dev bundle is built against one release; a new image starts over.
        if (
          saved.runtimeVersion === input.release &&
          (await isFile(NodePath.join(bundleRoot(saved.bundle.updateId), "index.html")))
        ) {
          current = saved;
          return;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await uninstall();
    },
    refresh: () => {
      running = running.then(poll).catch((error: unknown) => {
        console.warn("Dev updates: keeping the current bundle.", error);
      });
      return running;
    },
  };
}

async function writeFileAtomically(path: string, contents: string) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporaryPath, contents);
  await NodeFSP.rename(temporaryPath, path);
}

interface MultipartPart {
  readonly name: string | null;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** Splits a multipart/mixed body, keeping each part's exact bytes for signature checks. */
function parseMultipart(body: Buffer, boundary: string): ReadonlyArray<MultipartPart> {
  const parts: MultipartPart[] = [];
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  let start = body.indexOf(`--${boundary}`);
  if (start < 0) return parts;
  start += boundary.length + 2;
  while (body.subarray(start, start + 2).toString() === "\r\n") {
    const end = body.indexOf(delimiter, start + 2);
    if (end < 0) break;
    const part = body.subarray(start + 2, end);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const headers: Record<string, string> = {};
    for (const line of part.subarray(0, headerEnd).toString("utf8").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0)
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const name = /name="([^"]*)"/.exec(headers["content-disposition"] ?? "")?.[1] ?? null;
    parts.push({ name, headers, body: part.subarray(headerEnd + 4) });
    start = end + delimiter.length;
  }
  return parts;
}

function verifyExpoSignature(body: Buffer, header: string | undefined, key: NodeCrypto.KeyObject) {
  const fields = Object.fromEntries(
    [...(header ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  if (fields.sig === undefined || fields.alg !== "rsa-v1_5-sha256") {
    throw new Error("manifest is not signed");
  }
  if (!NodeCrypto.verify("RSA-SHA256", body, key, Buffer.from(fields.sig, "base64"))) {
    throw new Error("manifest signature does not verify");
  }
}

/**
 * Extracts the regular files and directories of a gzipped ustar archive (with
 * pax and GNU long names), refusing any entry that would land outside `target`.
 */
async function extractTarGz(archivePath: string, target: string) {
  const root = NodePath.resolve(target);
  await NodeFSP.mkdir(root, { recursive: true });
  const reader = byteReader(NodeFS.createReadStream(archivePath).pipe(NodeZlib.createGunzip()));
  const field = (header: Buffer, start: number, length: number) => {
    const bytes = header.subarray(start, start + length);
    const end = bytes.indexOf(0);
    return bytes.subarray(0, end < 0 ? length : end).toString("utf8");
  };
  let longName: string | null = null;
  for (;;) {
    const header = await reader.read(512);
    if (!header || header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = field(header, 156, 1) || "0";
    const prefix = field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
    const headerName = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    const padding = (512 - (size % 512)) % 512;

    if (type === "L" || type === "x") {
      if (size > 1024 * 1024) throw new Error("archive has an oversized name record");
      const chunks: Buffer[] = [];
      for await (const chunk of reader.chunks(size)) chunks.push(chunk);
      const data = Buffer.concat(chunks).toString("utf8");
      longName =
        type === "L"
          ? data.replace(/\0+$/, "")
          : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(data)?.[1] ?? longName);
      for await (const _ of reader.chunks(padding));
      continue;
    }
    const name = longName ?? headerName;
    longName = null;
    const destination = NodePath.resolve(root, name);
    const kept = (type === "0" || type === "5") && destination !== root;
    if (kept && !destination.startsWith(`${root}${NodePath.sep}`)) {
      throw new Error(`archive entry ${name} leaves the bundle`);
    }
    if (kept && type === "5") {
      await NodeFSP.mkdir(destination, { recursive: true });
    } else if (kept) {
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      const file = await NodeFSP.open(destination, "w");
      try {
        for await (const chunk of reader.chunks(size)) await file.write(chunk);
      } finally {
        await file.close();
      }
    } else {
      for await (const _ of reader.chunks(size));
    }
    for await (const _ of reader.chunks(padding));
  }
}

function byteReader(source: AsyncIterable<Buffer>) {
  const iterator = source[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  const fill = async () => {
    const next = await iterator.next();
    if (next.done) return false;
    buffered = buffered.length === 0 ? next.value : Buffer.concat([buffered, next.value]);
    return true;
  };
  return {
    async read(length: number): Promise<Buffer | null> {
      while (buffered.length < length) if (!(await fill())) return null;
      const out = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      return out;
    },
    async *chunks(length: number): AsyncGenerator<Buffer> {
      let left = length;
      while (left > 0) {
        if (buffered.length === 0 && !(await fill())) {
          throw new Error("archive ends inside an entry");
        }
        const out = buffered.subarray(0, Math.min(left, buffered.length));
        buffered = buffered.subarray(out.length);
        left -= out.length;
        yield out;
      }
    },
  };
}

interface AccessJwk extends NodeCrypto.JsonWebKey {
  readonly kid?: string;
}

/**
 * Verifies the `Cf-Access-Jwt-Assertion` header Cloudflare Access adds after
 * login, so requests that reach this server without passing Access are refused.
 */
export function makeCloudflareAccessVerifier(input: {
  readonly teamDomain: string;
  readonly audience: string;
  readonly fetchKeys?: () => Promise<ReadonlyArray<AccessJwk>>;
  readonly now?: () => number;
}): AccessVerifier {
  const issuer = `https://${input.teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const fetchKeys =
    input.fetchKeys ??
    (async () => {
      const response = await fetch(`${issuer}/cdn-cgi/access/certs`);
      if (!response.ok) throw new Error(`Cloudflare Access certs: HTTP ${response.status}`);
      return ((await response.json()) as { keys: ReadonlyArray<AccessJwk> }).keys;
    });
  let keys: ReadonlyArray<AccessJwk> = [];

  return async (request) => {
    const token = request.headers["cf-access-jwt-assertion"];
    if (typeof token !== "string") return false;
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return false;
    try {
      const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as {
        alg?: string;
        kid?: string;
      };
      if (header.alg !== "RS256") return false;
      // Access rotates signing keys, so an unknown kid triggers one refresh.
      if (!keys.some((key) => key.kid === header.kid)) keys = await fetchKeys();
      const jwk = keys.find((key) => key.kid === header.kid);
      if (jwk === undefined) return false;
      const signed = NodeCrypto.verify(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        NodeCrypto.createPublicKey({ key: jwk, format: "jwk" }),
        Buffer.from(encodedSignature, "base64url"),
      );
      if (!signed) return false;
      const claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
        aud?: string | ReadonlyArray<string>;
        exp?: number;
        iss?: string;
      };
      const audiences = typeof claims.aud === "string" ? [claims.aud] : (claims.aud ?? []);
      const nowSeconds = (input.now?.() ?? Date.now()) / 1000;
      return (
        claims.iss === issuer &&
        audiences.includes(input.audience) &&
        typeof claims.exp === "number" &&
        claims.exp > nowSeconds
      );
    } catch {
      return false;
    }
  };
}

async function startDevBundles(catalogDir: string): Promise<DevBundleStore | undefined> {
  const release = process.env.T3CODE_RELEASE?.trim();
  if (!release) return undefined;
  const certificatePath =
    process.env.OTA_CERTIFICATE?.trim() ||
    NodePath.join(import.meta.dirname, "ota-certificate.pem");
  let verificationKey: NodeCrypto.KeyObject;
  try {
    verificationKey = new NodeCrypto.X509Certificate(await NodeFSP.readFile(certificatePath))
      .publicKey;
  } catch (error) {
    // The release bundle matters more than the dev lane, so a missing certificate only turns the lane off.
    console.error(`Dev updates are off: cannot read ${certificatePath}.`, error);
    return undefined;
  }
  const store = makeDevBundleStore({
    release,
    directory: NodePath.join(catalogDir, "dev-updates"),
    verificationKey,
  });
  await store.load();
  void store.refresh();
  setInterval(() => void store.refresh(), DEV_UPDATES_POLL_MS);
  return store;
}

if (import.meta.main) {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = process.env.CF_ACCESS_AUD?.trim();
  const port = Number(process.env.PORT ?? 8080);
  let access: AccessVerifier;
  if (teamDomain && audience) {
    access = makeCloudflareAccessVerifier({ teamDomain, audience });
  } else if (process.env.ALLOW_UNVERIFIED_CATALOG === "true") {
    console.warn("ALLOW_UNVERIFIED_CATALOG=true: the catalog trusts every request.");
    access = async () => true;
  } else {
    console.warn(
      "CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are unset; the catalog refuses requests.",
    );
    access = async () => false;
  }
  const catalogDir = required("CATALOG_DIR");
  const devBundles = await startDevBundles(catalogDir);
  createSelfHostedServer({
    webRoot: required("WEB_ROOT"),
    catalogDir,
    historyLimit: Number(process.env.HISTORY_LIMIT ?? 100),
    access,
    devBundles,
  }).listen(port, () => {
    console.log(`Serving T3 Code web with a shared connection catalog on :${port}`);
  });
  // As PID 1 in a container, Node installs no default signal handlers. Exiting
  // at once is safe because catalog writes land by atomic rename.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
}
