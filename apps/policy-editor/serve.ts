#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Runs alone in a Node-only image, without dependencies.
/**
 * Serves `POLICY_DIR/<name>.json` on an admin listener (`PORT`, 8080: the editor and the write
 * API, for administrators only) and a public read-only one (`PUBLIC_PORT`, 8081). See README.md.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export const POLICY_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const API_PATH = "/api/policies";
const MAX_POLICY_BYTES = 256 * 1024;
const LEGACY_FILE = "policy.json";
const MIGRATED_NAME = "dotfiles";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface PolicySummary {
  readonly name: string;
  readonly etag: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly publicUrl: string;
}

interface StoredPolicy {
  readonly raw: string;
  readonly etag: string;
  readonly modifiedAt: Date;
}

type WriteResult =
  | { readonly status: "saved"; readonly etag: string; readonly savedAt: Date }
  | { readonly status: "conflict"; readonly current: string | null };

type DeleteResult =
  | { readonly status: "deleted" }
  | { readonly status: "conflict"; readonly current: string | null };

export interface PolicyStore {
  readonly directory: string;
  readonly list: () => Promise<ReadonlyArray<StoredPolicy & { readonly name: string }>>;
  readonly read: (name: string) => Promise<StoredPolicy | null>;
  /** `expected` null means the policy must not exist yet, and `*` that it must. */
  readonly write: (name: string, raw: string, expected: string | null) => Promise<WriteResult>;
  readonly remove: (name: string, expected: string) => Promise<DeleteResult>;
}

const sha256Of = (raw: string) => NodeCrypto.createHash("sha256").update(raw).digest("hex");
const etagOf = (raw: string) => `"${sha256Of(raw)}"`;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function exists(path: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** A rename or unlink is durable only once the directory entry is. */
async function syncDirectory(directory: string) {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Opens `directory` as the policy store: removes temporary files a crashed process left behind,
 * and moves the single-policy layout's `policy.json` to `dotfiles.json` once.
 */
export async function openPolicyStore(directory: string): Promise<PolicyStore> {
  for (const name of await NodeFSP.readdir(directory)) {
    if (/\.json\..+\.tmp$/.test(name)) {
      await NodeFSP.rm(NodePath.join(directory, name), { force: true });
    }
  }
  const legacy = NodePath.join(directory, LEGACY_FILE);
  const migrated = NodePath.join(directory, `${MIGRATED_NAME}.json`);
  if (await exists(legacy)) {
    if (await exists(migrated)) {
      console.warn(
        `${LEGACY_FILE} and ${MIGRATED_NAME}.json both exist in ${directory}; leaving both. ${LEGACY_FILE} is served as the policy "policy".`,
      );
    } else {
      // Only this process writes POLICY_DIR, and it has not started serving, so nothing can
      // create dotfiles.json between the check and the rename.
      await NodeFSP.rename(legacy, migrated);
      await syncDirectory(directory);
      console.log(`migrated ${LEGACY_FILE} to ${MIGRATED_NAME}.json in ${directory}`);
    }
  }

  const pathOf = (name: string) => {
    if (!POLICY_NAME.test(name)) throw new Error(`invalid policy name ${JSON.stringify(name)}`);
    return NodePath.join(directory, `${name}.json`);
  };

  // Serializes every read-compare-write, so two changes can never both match one ETag.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(task: () => Promise<A>): Promise<A> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const read = async (name: string): Promise<StoredPolicy | null> => {
    const path = pathOf(name);
    try {
      const [raw, stat] = await Promise.all([NodeFSP.readFile(path, "utf8"), NodeFSP.stat(path)]);
      return { raw, etag: etagOf(raw), modifiedAt: stat.mtime };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };

  const list = async () => {
    const names = (await NodeFSP.readdir(directory))
      .map((file) => /^(.+)\.json$/.exec(file)?.[1])
      .filter((name): name is string => name !== undefined && POLICY_NAME.test(name))
      .toSorted();
    const policies = await Promise.all(
      names.map(async (name) => {
        const policy = await read(name);
        return policy === null ? null : { name, ...policy };
      }),
    );
    return policies.filter((policy) => policy !== null);
  };

  const matches = (current: StoredPolicy | null, expected: string | null) =>
    expected === null
      ? current === null
      : expected === "*"
        ? current !== null
        : current?.etag === expected;

  const write = (name: string, raw: string, expected: string | null) =>
    exclusive(async (): Promise<WriteResult> => {
      const path = pathOf(name);
      const current = await read(name);
      if (!matches(current, expected))
        return { status: "conflict", current: current?.etag ?? null };
      // Renaming over the policy is the commit point; hosts never see a partial file.
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        const file = await NodeFSP.open(temporary, "w");
        try {
          await file.writeFile(raw);
          await file.sync();
        } finally {
          await file.close();
        }
        await NodeFSP.rename(temporary, path);
      } catch (error) {
        await NodeFSP.rm(temporary, { force: true });
        throw error;
      }
      // The rename has committed the write, so a failure from here on is a warning.
      let savedAt = new Date();
      try {
        await syncDirectory(directory);
        savedAt = (await NodeFSP.stat(path)).mtime;
      } catch (error) {
        console.warn(`${name} saved, but syncing ${directory} failed: ${(error as Error).message}`);
      }
      const etag = etagOf(raw);
      console.log(`policy ${name} saved sha=${etag.slice(1, 13)} size=${Buffer.byteLength(raw)}`);
      return { status: "saved", etag, savedAt };
    });

  const remove = (name: string, expected: string) =>
    exclusive(async (): Promise<DeleteResult> => {
      const current = await read(name);
      if (!matches(current, expected))
        return { status: "conflict", current: current?.etag ?? null };
      await NodeFSP.rm(pathOf(name));
      try {
        await syncDirectory(directory);
      } catch (error) {
        console.warn(
          `${name} deleted, but syncing ${directory} failed: ${(error as Error).message}`,
        );
      }
      console.log(`policy ${name} deleted sha=${current?.etag.slice(1, 13)}`);
      return { status: "deleted" };
    });

  return { directory, list, read, write, remove };
}

function fail(
  response: NodeHttp.ServerResponse,
  status: number,
  error: string,
  headers: NodeHttp.OutgoingHttpHeaders = {},
) {
  response
    .writeHead(status, { ...headers, "Content-Type": "application/json" })
    .end(`${JSON.stringify({ error })}\n`);
}

function serve(
  route: (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    pathname: string,
  ) => Promise<void>,
): NodeHttp.Server {
  return NodeHttp.createServer((request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      fail(response, 400, "The request URL is malformed.");
      return;
    }
    route(request, response, pathname).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) fail(response, 500, "The server could not complete the request.");
      else response.end();
    });
  });
}

async function directoryProblem(directory: string, access: number): Promise<string | undefined> {
  try {
    if (!(await NodeFSP.stat(directory)).isDirectory()) return `${directory} is a file`;
    await NodeFSP.access(directory, access);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

export interface AdminServerOptions {
  readonly webRoot: string;
  readonly store: PolicyStore;
  readonly publicUrl: string;
}

/** The editor and the write API. It has no login, so serve it only to administrators. */
export function createAdminServer(options: AdminServerOptions): NodeHttp.Server {
  const root = NodePath.resolve(options.webRoot);
  const publicBase = options.publicUrl.replace(/\/+$/, "");
  return serve(async (request, response, pathname) => {
    if (pathname === API_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        fail(response, 405, "Use GET.", { Allow: "GET, HEAD" });
        return;
      }
      const policies: ReadonlyArray<PolicySummary> = (await options.store.list()).map((policy) => ({
        name: policy.name,
        etag: policy.etag,
        size: Buffer.byteLength(policy.raw),
        modifiedAt: policy.modifiedAt.toISOString(),
        publicUrl: `${publicBase}/${policy.name}.json`,
      }));
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      response.end(request.method === "HEAD" ? undefined : `${JSON.stringify({ policies })}\n`);
      return;
    }
    if (pathname.startsWith(`${API_PATH}/`)) {
      return handlePolicy(request, response, options.store, pathname.slice(API_PATH.length + 1));
    }
    if (pathname === "/healthz") {
      const problem = await directoryProblem(options.store.directory, NodeFS.constants.W_OK);
      if (problem === undefined)
        response.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
      else fail(response, 503, `POLICY_DIR is not a writable directory: ${problem}`);
      return;
    }
    return serveStatic(request, response, root, pathname);
  });
}

async function handlePolicy(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  store: PolicyStore,
  name: string,
) {
  response.setHeader("Cache-Control", "no-cache");
  if (!POLICY_NAME.test(name)) {
    fail(
      response,
      400,
      "A policy name is 1 to 63 lowercase letters, digits and hyphens, starting with a letter or digit.",
    );
    return;
  }
  const method = request.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    const current = await store.read(name);
    if (current === null) {
      fail(response, 404, `There is no policy named ${name}.`);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      ETag: current.etag,
      "Last-Modified": current.modifiedAt.toUTCString(),
    });
    response.end(method === "HEAD" ? undefined : current.raw);
    return;
  }
  if (method !== "PUT" && method !== "DELETE") {
    fail(response, 405, "Use GET, PUT or DELETE.", { Allow: "GET, HEAD, PUT, DELETE" });
    return;
  }

  // Accept the weak form a compressing proxy hands the browser: it still hashes one stored version.
  const ifMatch = request.headers["if-match"]?.replace(/^W\//, "") ?? null;
  if (method === "DELETE") {
    if (ifMatch === null) {
      fail(response, 428, `Send If-Match: "<etag>" to delete ${name}.`);
      return;
    }
    const result = await store.remove(name, ifMatch);
    if (result.status === "conflict") {
      fail(
        response,
        412,
        result.current === null
          ? `There is no policy named ${name}.`
          : `${name} changed since you loaded it; it is now ${result.current}.`,
      );
      return;
    }
    response.writeHead(204).end();
    return;
  }

  const createOnly = request.headers["if-none-match"] === "*";
  if (ifMatch === null && !createOnly) {
    fail(
      response,
      428,
      `Send If-Match: "<etag>" to replace ${name}, or If-None-Match: * to create it.`,
    );
    return;
  }
  const raw =
    Number(request.headers["content-length"] ?? 0) > MAX_POLICY_BYTES
      ? null
      : await readBody(request);
  if (raw === null) {
    // Closing stops the client sending the rest of a body nobody will read.
    fail(response, 413, `A policy is at most ${MAX_POLICY_BYTES / 1024} KiB.`, {
      Connection: "close",
    });
    return;
  }
  const problem = checkPolicyShape(raw);
  if (problem !== undefined) {
    fail(response, 400, problem);
    return;
  }
  const result = await store.write(name, raw, createOnly ? null : ifMatch);
  if (result.status === "conflict") {
    fail(
      response,
      412,
      result.current === null
        ? `There is no policy named ${name}; create it with If-None-Match: *.`
        : createOnly
          ? `A policy named ${name} already exists; replace it with If-Match: ${result.current}.`
          : `${name} changed since you loaded it; it is now ${result.current}. Reload and save again.`,
    );
    return;
  }
  response
    .writeHead(200, {
      "Content-Type": "application/json",
      ETag: result.etag,
      "Last-Modified": result.savedAt.toUTCString(),
    })
    .end(
      `${JSON.stringify({ name, sha256: result.etag.slice(1, -1), size: Buffer.byteLength(raw), savedAt: result.savedAt.toISOString() })}\n`,
    );
}

/** Only what a host's `t3 policy check` cannot recover from; the editor validates the rest. */
function checkPolicyShape(raw: string): string | undefined {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return `The body is not valid JSON: ${(error as Error).message}`;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return "A policy is a JSON object.";
  }
  const record = document as Record<string, unknown>;
  if (record.schemaVersion !== 1) return "schemaVersion must be 1.";
  if (typeof record.organization !== "string") return "organization must be a string.";
  return undefined;
}

async function readBody(request: NodeHttp.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_POLICY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  root: string,
  pathname: string,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let path: string;
  let body: Buffer;
  try {
    path = NodePath.resolve(
      root,
      `.${pathname === "/" ? "/index.html" : decodeURIComponent(pathname)}`,
    );
    if (!path.startsWith(`${root}${NodePath.sep}`)) throw new Error("outside the web root");
    body = await NodeFSP.readFile(path);
  } catch {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type":
      CONTENT_TYPES[NodePath.extname(path).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": path.startsWith(NodePath.join(root, "assets") + NodePath.sep)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

const PUBLIC_POLICY_PATH = /^\/([a-z0-9][a-z0-9-]{0,62})\.json$/;

/**
 * What hosts fetch, reachable from the internet with no login in front: it reads one named
 * policy at a time and has no route that lists or writes.
 */
export function createPublicServer(options: { readonly store: PolicyStore }): NodeHttp.Server {
  return serve(async (request, response, pathname) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      fail(response, 405, "This server is read-only.", { Allow: "GET, HEAD" });
      return;
    }
    if (pathname === "/healthz") {
      // No detail: the reason would name paths inside the container.
      if ((await directoryProblem(options.store.directory, NodeFS.constants.R_OK)) === undefined) {
        response.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
      } else {
        fail(response, 503, "Policies are unavailable.");
      }
      return;
    }
    const name = PUBLIC_POLICY_PATH.exec(pathname)?.[1];
    const policy = name === undefined ? null : await options.store.read(name);
    if (policy === null) {
      fail(response, 404, "Not found.");
      return;
    }
    const headers = {
      "Content-Type": "application/json",
      ETag: policy.etag,
      "Cache-Control": "no-cache",
      "Last-Modified": policy.modifiedAt.toUTCString(),
      "X-Content-Type-Options": "nosniff",
    };
    const ifNoneMatch = request.headers["if-none-match"];
    if (
      ifNoneMatch !== undefined &&
      ifNoneMatch
        .split(",")
        .map((tag) => tag.trim().replace(/^W\//, ""))
        .some((tag) => tag === "*" || tag === policy.etag)
    ) {
      response.writeHead(304, headers).end();
      return;
    }
    response.writeHead(200, headers).end(request.method === "HEAD" ? undefined : policy.raw);
  });
}

if (import.meta.main) {
  const policyDir = process.env.POLICY_DIR?.trim();
  if (!policyDir) throw new Error("POLICY_DIR is required.");
  const webRoot = process.env.WEB_ROOT ?? "dist";
  const port = Number(process.env.PORT ?? 8080);
  const publicPort = Number(process.env.PUBLIC_PORT ?? 8081);
  const publicUrl = process.env.PUBLIC_URL?.trim() || "https://t3-policy.clusters.work";
  const store = await openPolicyStore(policyDir);
  createAdminServer({ webRoot, store, publicUrl }).listen(port, () =>
    console.log(
      `admin: ${NodePath.resolve(webRoot)} and ${API_PATH} from ${policyDir} on :${port}`,
    ),
  );
  createPublicServer({ store }).listen(publicPort, () =>
    console.log(`public: GET /<name>.json from ${policyDir} on :${publicPort}`),
  );
  // As PID 1 in a container, Node installs no default signal handlers. Exiting at once is safe
  // because policy writes land by atomic rename.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
}
