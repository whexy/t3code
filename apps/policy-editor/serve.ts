#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Runs alone in a Node-only image, without dependencies.
/**
 * Serves the built editor (`dist/`) for the container image. The editor keeps policies in the
 * browser, so this only serves files, plus `GET /healthz` for probes.
 *
 * Environment: `WEB_ROOT` (default `./dist`) and `PORT` (default 8080).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const root = NodePath.resolve(process.env.WEB_ROOT ?? "dist");
const port = Number(process.env.PORT ?? 8080);

async function readFile(pathname: string) {
  const path = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!path.startsWith(`${root}${NodePath.sep}`)) return undefined;
  try {
    return { path, body: await NodeFSP.readFile(path) };
  } catch {
    return undefined;
  }
}

async function handle(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  if (pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
    return;
  }
  const file = await readFile(pathname);
  if (file === undefined) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type":
      CONTENT_TYPES[NodePath.extname(file.path).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": file.path.startsWith(NodePath.join(root, "assets") + NodePath.sep)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : file.body);
}

NodeHttp.createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
}).listen(port, () => console.log(`Serving ${root} on :${port}`));
