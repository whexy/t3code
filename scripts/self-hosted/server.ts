#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - Runs alone in a Node-only image, without workspace dependencies.
/**
 * Serves a static web build together with one shared connection catalog, so a
 * self-hosted T3 Code web app shows the same environments in every browser.
 * Build the web app with `VITE_SHARED_CATALOG_PATH=/__t3code/shared-catalog`.
 *
 * Environment:
 * - `WEB_ROOT`: built `apps/web/dist` directory.
 * - `CATALOG_DIR`: writable directory for `catalog.json` and `history/`.
 * - `PORT`: listen port, default 8080.
 * - `HISTORY_LIMIT`: saved catalog versions to keep, default 100.
 * - `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`: catalog requests must carry a
 *   valid Cloudflare Access JWT for that application. Without them the catalog
 *   refuses every request, unless `ALLOW_UNVERIFIED_CATALOG=true` (local use).
 *
 * The catalog holds bearer tokens for every paired environment, so run this
 * only behind an access gate. Every accepted write is kept in `history/`; to
 * roll back, copy a history file over `catalog.json`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export const SHARED_CATALOG_PATH = "/__t3code/shared-catalog";
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
}

export type AccessVerifier = (request: NodeHttp.IncomingMessage) => Promise<boolean>;

export function createSelfHostedServer(options: SelfHostedServerOptions): NodeHttp.Server {
  const catalog = makeCatalogFile(options.catalogDir, options.historyLimit);
  return NodeHttp.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const handled =
      pathname === SHARED_CATALOG_PATH
        ? handleCatalog(request, response, catalog, options.access)
        : serveStatic(request, response, options.webRoot, pathname);
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

async function serveStatic(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  webRoot: string,
  pathname: string,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const root = NodePath.resolve(webRoot);
  let filePath = NodePath.resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!filePath.startsWith(`${root}${NodePath.sep}`) || !(await isFile(filePath))) {
    // Client-side routes resolve to the app shell.
    filePath = NodePath.join(root, "index.html");
  }
  const body = await NodeFSP.readFile(filePath);
  const hashedAsset = filePath.startsWith(NodePath.join(root, "assets") + NodePath.sep);
  response.writeHead(200, {
    "Content-Type":
      CONTENT_TYPES[NodePath.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
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
  createSelfHostedServer({
    webRoot: required("WEB_ROOT"),
    catalogDir: required("CATALOG_DIR"),
    historyLimit: Number(process.env.HISTORY_LIMIT ?? 100),
    access,
  }).listen(port, () => {
    console.log(`Serving T3 Code web with a shared connection catalog on :${port}`);
  });
  // As PID 1 in a container, Node installs no default signal handlers. Exiting
  // at once is safe because catalog writes land by atomic rename.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
}
