#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Runs alone in a Node-only image, without dependencies.
/**
 * Serves the built editor and the fleet policy hosts fetch at start: `GET`/`PUT /policy.json`
 * (sha256 ETag; PUT needs `If-None-Match: *` or `If-Match`) and `GET /healthz`.
 * Environment: `POLICY_DIR` (required), `WEB_ROOT` (default `./dist`), `PORT` (default 8080).
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export const POLICY_PATH = "/policy.json";
const MAX_POLICY_BYTES = 256 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface PolicyEditorServerOptions {
  readonly webRoot: string;
  readonly policyDir: string;
}

export function createPolicyEditorServer(options: PolicyEditorServerOptions): NodeHttp.Server {
  const store = makePolicyStore(options.policyDir);
  const root = NodePath.resolve(options.webRoot);
  const route = async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      fail(response, 400, "The request URL is malformed.");
      return;
    }
    if (pathname === POLICY_PATH) return handlePolicy(request, response, store);
    if (pathname === "/healthz") return handleHealth(response, options.policyDir);
    return serveStatic(request, response, root, pathname);
  };
  return NodeHttp.createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) fail(response, 500, "The server could not complete the request.");
      else response.end();
    });
  });
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

async function handleHealth(response: NodeHttp.ServerResponse, policyDir: string) {
  try {
    if (!(await NodeFSP.stat(policyDir)).isDirectory()) throw new Error(`${policyDir} is a file`);
    await NodeFSP.access(policyDir, NodeFS.constants.W_OK);
  } catch (error) {
    fail(response, 503, `POLICY_DIR is not a writable directory: ${(error as Error).message}`);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
}

async function handlePolicy(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  store: PolicyStore,
) {
  response.setHeader("Cache-Control", "no-cache");
  if (request.method === "GET" || request.method === "HEAD") {
    const current = await store.read();
    if (current === null) {
      fail(response, 404, "No policy has been saved yet.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      ETag: current.etag,
      "Last-Modified": current.savedAt.toUTCString(),
    });
    response.end(request.method === "HEAD" ? undefined : current.raw);
    return;
  }
  if (request.method !== "PUT") {
    fail(response, 405, "Use GET or PUT.", { Allow: "GET, HEAD, PUT" });
    return;
  }

  // Accept the weak form a compressing proxy hands the browser: it still hashes one stored version.
  const ifMatch = request.headers["if-match"]?.replace(/^W\//, "") ?? null;
  const createOnly = request.headers["if-none-match"] === "*";
  if (ifMatch === null && !createOnly) {
    fail(
      response,
      428,
      'Send If-Match: "<etag>" to replace the policy, or If-None-Match: * to create it.',
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
  const result = await store.write(raw, createOnly ? null : ifMatch);
  if (result.status === "conflict") {
    fail(
      response,
      412,
      result.current === null
        ? "No policy has been saved yet; create it with If-None-Match: *."
        : createOnly
          ? `A policy already exists; replace it with If-Match: ${result.current}.`
          : `The policy changed since you loaded it; it is now ${result.current}. Reload and save again.`,
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
      `${JSON.stringify({ sha256: result.sha256, size: Buffer.byteLength(raw), savedAt: result.savedAt.toISOString() })}\n`,
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

type WriteResult =
  | {
      readonly status: "saved";
      readonly etag: string;
      readonly sha256: string;
      readonly savedAt: Date;
    }
  | { readonly status: "conflict"; readonly current: string | null };

interface PolicyStore {
  readonly read: () => Promise<{ raw: string; etag: string; savedAt: Date } | null>;
  /** `expectedEtag` null means the policy must not exist yet, and `*` that it must. */
  readonly write: (raw: string, expectedEtag: string | null) => Promise<WriteResult>;
}

const sha256Of = (raw: string) => NodeCrypto.createHash("sha256").update(raw).digest("hex");

function makePolicyStore(directory: string): PolicyStore {
  const currentPath = NodePath.join(directory, "policy.json");
  const temporaryPath = `${currentPath}.${process.pid}.tmp`;
  // Serializes read-compare-write so two saves can never both match one ETag. The first task
  // removes temporary files a crashed process left behind.
  let queue: Promise<unknown> = NodeFSP.readdir(directory)
    .then((names) =>
      Promise.all(
        names
          .filter((name) => /^policy\.json\..+\.tmp$/.test(name))
          .map((name) => NodeFSP.rm(NodePath.join(directory, name), { force: true })),
      ),
    )
    .catch((error: unknown) => console.error(error));
  const exclusive = <A>(task: () => Promise<A>): Promise<A> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const read = async () => {
    try {
      const [raw, stat] = await Promise.all([
        NodeFSP.readFile(currentPath, "utf8"),
        NodeFSP.stat(currentPath),
      ]);
      return { raw, etag: `"${sha256Of(raw)}"`, savedAt: stat.mtime };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const write = (raw: string, expectedEtag: string | null) =>
    exclusive(async (): Promise<WriteResult> => {
      const current = await read();
      const matches =
        expectedEtag === null
          ? current === null
          : expectedEtag === "*"
            ? current !== null
            : current?.etag === expectedEtag;
      if (!matches) return { status: "conflict", current: current?.etag ?? null };
      // Renaming over policy.json is the commit point; hosts never see a partial file.
      try {
        const file = await NodeFSP.open(temporaryPath, "w");
        try {
          await file.writeFile(raw);
          await file.sync();
        } finally {
          await file.close();
        }
        await NodeFSP.rename(temporaryPath, currentPath);
      } catch (error) {
        await NodeFSP.rm(temporaryPath, { force: true });
        throw error;
      }
      // The rename is durable only once the directory entry is. It has already committed the
      // write, so a failure from here on is a warning, not a failed save.
      let savedAt = new Date();
      try {
        const directoryHandle = await NodeFSP.open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
        savedAt = (await NodeFSP.stat(currentPath)).mtime;
      } catch (error) {
        console.warn(`policy saved, but syncing ${directory} failed: ${(error as Error).message}`);
      }
      const sha256 = sha256Of(raw);
      console.log(`policy saved sha=${sha256.slice(0, 12)} size=${Buffer.byteLength(raw)}`);
      return { status: "saved", etag: `"${sha256}"`, sha256, savedAt };
    });

  return { read, write };
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

if (import.meta.main) {
  const policyDir = process.env.POLICY_DIR?.trim();
  if (!policyDir) throw new Error("POLICY_DIR is required.");
  const webRoot = process.env.WEB_ROOT ?? "dist";
  const port = Number(process.env.PORT ?? 8080);
  createPolicyEditorServer({ webRoot, policyDir }).listen(port, () =>
    console.log(
      `Serving ${NodePath.resolve(webRoot)} and ${POLICY_PATH} from ${policyDir} on :${port}`,
    ),
  );
  // As PID 1 in a container, Node installs no default signal handlers. Exiting at once is safe
  // because policy writes land by atomic rename.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
}
