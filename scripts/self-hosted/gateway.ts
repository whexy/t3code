// @effect-diagnostics nodeBuiltinImport:off - Runs alone in a Node-only image, without workspace dependencies.
/**
 * Lets a self-hosted web app reach `t3 serve` backends that only this server
 * can reach, such as tailnet hosts behind a cluster egress proxy.
 *
 * The app keeps the backend URLs from its catalog. Two browser scripts move the
 * traffic: a service worker sends every request for an allowlisted backend
 * origin to `/__t3code/gateway/<host>:<port>/<path>` on this origin, and a
 * WebSocket shim does the same for sockets, which service workers never see.
 * The requests stay same-origin, so the access proxy's cookie covers them. The
 * backend receives its own Host, which is what its OAuth issuer is built from,
 * and none of the browser's cookies or access-proxy headers.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeStream from "node:stream";

import type { AccessVerifier } from "./server.ts";

export const GATEWAY_PATH = "/__t3code/gateway";
export const GATEWAY_WORKER_PATH = "/__t3code/gateway-worker.js";

/** Parses `GATEWAY_UPSTREAMS`: backend origins separated by commas or whitespace. */
export function parseGatewayUpstreams(raw: string): ReadonlyArray<string> {
  return raw
    .split(/[\s,]+/)
    .filter((entry) => entry !== "")
    .map((entry) => {
      const url = new URL(entry);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.username !== ""
      ) {
        throw new Error(`GATEWAY_UPSTREAMS: ${entry} is not an http(s) origin.`);
      }
      return url.origin;
    });
}

/**
 * Maps a request for an allowlisted backend to the gateway on `pageUrl`'s
 * origin, or returns null to leave it alone. The page and the service worker
 * run this function serialized into their scripts, so it may use only its
 * parameters and `URL`.
 */
export function toGatewayUrl(
  raw: string,
  pageUrl: string,
  upstreams: ReadonlyArray<string>,
): string | null {
  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    return null;
  }
  const socket = url.protocol === "ws:" || url.protocol === "wss:";
  const httpOrigin = socket
    ? `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`
    : url.origin;
  if (!upstreams.includes(httpOrigin)) return null;
  const page = new URL(pageUrl);
  const scheme = socket ? (page.protocol === "https:" ? "wss:" : "ws:") : page.protocol;
  return `${scheme}//${page.host}/__t3code/gateway/${url.host}${url.pathname}${url.search}`;
}

export interface Gateway {
  readonly owns: (pathname: string) => boolean;
  readonly handle: (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    pathname: string,
  ) => Promise<void>;
  readonly handleUpgrade: (
    request: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
  ) => Promise<void>;
  /** Adds the client script to the app shell, ahead of the app's own scripts. */
  readonly injectClient: (html: string) => string;
}

// Hop-by-hop headers, plus what identifies the browser or the access proxy
// rather than the request: the backend should see what a direct tailnet client
// sends.
const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
  "referer",
  "forwarded",
  "cdn-loop",
  "true-client-ip",
  "x-real-ip",
  "x-request-id",
  "x-scheme",
]);
const DROPPED_REQUEST_PREFIXES = ["cf-", "x-forwarded-", "x-original-"];
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Every backend shares this origin, so none may set cookies on it.
  "set-cookie",
]);

// Served at the worker's path while no upstreams are set, so a browser that
// installed the gateway worker removes it instead of sending requests to a
// gateway that is gone.
const RETIRED_WORKER_SCRIPT = `self.addEventListener("install", () => {
  void self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.registration
      .unregister()
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url)))),
  );
});
`;

/** With no upstreams the gateway forwards nothing and only retires its worker. */
export function makeGateway(input: {
  readonly upstreams: ReadonlyArray<string>;
  readonly access: AccessVerifier;
}): Gateway {
  const upstreams = new Map(
    input.upstreams.map((origin) => {
      const url = new URL(origin);
      return [url.host, url] as const;
    }),
  );
  const enabled = input.upstreams.length > 0;
  const preamble = [
    `const GATEWAY_UPSTREAMS = ${JSON.stringify(input.upstreams)};`,
    `const toGatewayUrl = ${toGatewayUrl.toString()};`,
  ].join("\n");
  const readSource = (name: string) =>
    NodeFS.readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
  const clientScript = [
    "(() => {",
    preamble,
    `const GATEWAY_WORKER_PATH = ${JSON.stringify(GATEWAY_WORKER_PATH)};`,
    readSource("gateway-client.js"),
    "})();",
  ].join("\n");
  const workerScript = enabled
    ? [preamble, readSource("gateway-worker.js")].join("\n")
    : RETIRED_WORKER_SCRIPT;

  const resolveTarget = (rawUrl: string) => {
    const prefix = `${GATEWAY_PATH}/`;
    if (!rawUrl.startsWith(prefix)) return null;
    const rest = rawUrl.slice(prefix.length);
    const end = rest.search(/[/?]/);
    const upstream = upstreams.get((end === -1 ? rest : rest.slice(0, end)).toLowerCase());
    if (upstream === undefined) return null;
    const tail = end === -1 ? "" : rest.slice(end);
    return { upstream, path: tail.startsWith("/") ? tail : `/${tail}` };
  };

  const backendRequest = (
    request: NodeHttp.IncomingMessage,
    target: { readonly upstream: URL; readonly path: string },
  ) => {
    const named = new Set(
      (request.headers.connection ?? "").split(",").map((token) => token.trim().toLowerCase()),
    );
    const headers: NodeHttp.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value === undefined ||
        named.has(name) ||
        DROPPED_REQUEST_HEADERS.has(name) ||
        DROPPED_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix))
      ) {
        continue;
      }
      headers[name] = value;
    }
    headers.host = target.upstream.host;
    if (request.headers.origin !== undefined) headers.origin = target.upstream.origin;
    if (request.headers.upgrade !== undefined) {
      headers.connection = "Upgrade";
      headers.upgrade = request.headers.upgrade;
    }
    const transport = target.upstream.protocol === "https:" ? NodeHttps : NodeHttp;
    return transport.request({
      hostname: target.upstream.hostname,
      port: target.upstream.port,
      method: request.method,
      path: target.path,
      headers,
    });
  };

  const browserHeaders = (
    headers: NodeHttp.IncomingHttpHeaders,
    target: { readonly upstream: URL; readonly path: string },
  ) => {
    const result: NodeHttp.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) result[name] = value;
    }
    if (typeof headers.location === "string") {
      // The worker follows redirects itself, so one that points back at a
      // backend has to stay on the gateway.
      const location = new URL(headers.location, new URL(target.path, target.upstream));
      if (upstreams.get(location.host)?.origin === location.origin) {
        result.location = `${GATEWAY_PATH}/${location.host}${location.pathname}${location.search}`;
      }
    }
    return result;
  };

  const handle: Gateway["handle"] = async (request, response, pathname) => {
    if (pathname === GATEWAY_WORKER_PATH) {
      response
        .writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
          // The worker lives under /__t3code/ but routes requests from every page.
          "Service-Worker-Allowed": "/",
        })
        .end(request.method === "HEAD" ? undefined : workerScript);
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    const target = resolveTarget(request.url ?? "");
    if (target === null) {
      response.writeHead(404).end();
      return;
    }
    if (!(await input.access(request))) {
      response.writeHead(403).end();
      return;
    }
    const upstream = backendRequest(request, target);
    upstream.on("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        browserHeaders(upstreamResponse.headers, target),
      );
      upstreamResponse.on("error", () => response.destroy());
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    // A browser that stops reading, such as a closed event stream, ends the
    // backend request too.
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.on("error", () => upstream.destroy());
    request.pipe(upstream);
  };

  const refuse = (socket: NodeStream.Duplex, status: number) => {
    socket.end(
      `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  };

  const handleUpgrade: Gateway["handleUpgrade"] = async (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    const target = resolveTarget(request.url ?? "");
    if (target === null) return refuse(socket, 404);
    if (!(await input.access(request))) return refuse(socket, 403);
    const upstream = backendRequest(request, target);
    socket.on("close", () => upstream.destroy());
    upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 101 ${upstreamResponse.statusMessage ?? "Switching Protocols"}`];
      const raw = upstreamResponse.rawHeaders;
      for (let index = 0; index + 1 < raw.length; index += 2) {
        if (raw[index]?.toLowerCase() !== "set-cookie")
          lines.push(`${raw[index]}: ${raw[index + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    // The backend answered without upgrading, for example to an expired ticket.
    upstream.on("response", (upstreamResponse) => {
      upstreamResponse.resume();
      refuse(socket, upstreamResponse.statusCode ?? 502);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  };

  return {
    owns: (pathname) => pathname === GATEWAY_WORKER_PATH || pathname.startsWith(`${GATEWAY_PATH}/`),
    handle,
    handleUpgrade,
    injectClient: (html) =>
      enabled
        ? html.replace(/<head[^>]*>/i, (tag) => `${tag}<script>${clientScript}</script>`)
        : html,
  };
}
