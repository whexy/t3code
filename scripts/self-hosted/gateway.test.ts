// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercises the Node-only gateway over real HTTP, and its browser scripts in a VM.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import * as NodeVM from "node:vm";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { GATEWAY_WORKER_PATH, parseGatewayUpstreams, toGatewayUrl } from "./gateway.ts";
import { type AccessVerifier, createSelfHostedServer } from "./server.ts";

const TAILNET_BACKEND = "https://mudd.example.ts.net:35338";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function listen(server: NodeHttp.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
}

interface SeenRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

/** A stand-in `t3 serve` backend that records what reaches it. */
async function startBackend() {
  const seen: SeenRequest[] = [];
  const server = NodeHttp.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
    seen.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (request.url === "/moved") {
      response.writeHead(302, { Location: "/api/next?page=2" }).end();
      return;
    }
    response
      .writeHead(201, { "Content-Type": "text/plain", "Set-Cookie": "session=backend" })
      .end("from backend");
  });
  server.on("upgrade", (request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers, body: "" });
    if (request.url?.includes("expired") === true) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: accepted\r\nSet-Cookie: session=backend\r\n\r\n",
    );
    socket.pipe(socket);
  });
  const host = await listen(server);
  return { origin: `http://${host}`, host, seen };
}

async function startGateway(input: { upstreams: ReadonlyArray<string>; access?: AccessVerifier }) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-gateway-"));
  cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const webRoot = NodePath.join(directory, "web");
  await NodeFSP.mkdir(webRoot);
  await NodeFSP.writeFile(
    NodePath.join(webRoot, "index.html"),
    '<!doctype html><html><head><script src="/assets/app.js"></script></head></html>',
  );
  const server = createSelfHostedServer({
    webRoot,
    catalogDir: NodePath.join(directory, "catalog"),
    historyLimit: 10,
    access: input.access ?? (async () => true),
    gatewayUpstreams: input.upstreams,
  });
  return `http://${await listen(server)}`;
}

function send(
  url: string,
  input: { method?: string; headers?: NodeHttp.OutgoingHttpHeaders; body?: string } = {},
) {
  return new Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const request = NodeHttp.request(
        url,
        { method: input.method ?? "GET", headers: input.headers ?? {} },
        async (response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of response as AsyncIterable<Buffer>) chunks.push(chunk);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        },
      );
      request.on("error", reject);
      request.end(input.body);
    },
  );
}

/** Opens an upgrade the way a browser WebSocket does, then sends `message` and reads one reply. */
function upgrade(url: string, message: string) {
  return new Promise<
    | { upgraded: true; headers: NodeHttp.IncomingHttpHeaders; reply: string }
    | { upgraded: false; status: number }
  >((resolve, reject) => {
    const request = NodeHttp.request(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        Cookie: "CF_Authorization=browser",
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.once("data", (data: Buffer) => {
        resolve({ upgraded: true, headers: response.headers, reply: data.toString("utf8") });
        socket.destroy();
      });
      socket.write(message);
    });
    request.on("response", (response) => {
      response.resume();
      resolve({ upgraded: false, status: response.statusCode ?? 0 });
    });
    request.on("error", reject);
    request.end();
  });
}

describe("toGatewayUrl", () => {
  const upstreams = [TAILNET_BACKEND, "http://lan.example:3773"];

  it("routes allowlisted backends through the page origin and leaves the rest alone", () => {
    const page = "https://t3n.example/chat/1";
    expect(toGatewayUrl(`${TAILNET_BACKEND}/api/x?y=1#frag`, page, upstreams)).toBe(
      "https://t3n.example/__t3code/gateway/mudd.example.ts.net:35338/api/x?y=1",
    );
    expect(toGatewayUrl("wss://mudd.example.ts.net:35338/ws?wsTicket=t", page, upstreams)).toBe(
      "wss://t3n.example/__t3code/gateway/mudd.example.ts.net:35338/ws?wsTicket=t",
    );
    expect(toGatewayUrl("ws://lan.example:3773/ws", page, upstreams)).toBe(
      "wss://t3n.example/__t3code/gateway/lan.example:3773/ws",
    );
    // Same host on another port or scheme is another origin.
    expect(toGatewayUrl("https://mudd.example.ts.net:5173/", page, upstreams)).toBeNull();
    expect(toGatewayUrl("http://mudd.example.ts.net:35338/", page, upstreams)).toBeNull();
    expect(toGatewayUrl("/__t3code/shared-catalog", page, upstreams)).toBeNull();
    expect(toGatewayUrl("https://clerk.example/v1", page, upstreams)).toBeNull();
  });

  it("parses GATEWAY_UPSTREAMS into origins and rejects anything else", () => {
    expect(parseGatewayUpstreams(`${TAILNET_BACKEND}/, http://LAN.example:3773\n`)).toEqual([
      TAILNET_BACKEND,
      "http://lan.example:3773",
    ]);
    expect(parseGatewayUpstreams("")).toEqual([]);
    expect(() => parseGatewayUpstreams("https://mudd.example.ts.net:35338/api")).toThrow();
    expect(() => parseGatewayUpstreams("ftp://mudd.example.ts.net")).toThrow();
  });
});

describe("gateway proxy", () => {
  it("forwards requests as a direct tailnet client would send them", async () => {
    const backend = await startBackend();
    const gateway = await startGateway({ upstreams: [backend.origin] });

    const response = await send(`${gateway}/__t3code/gateway/${backend.host}/api/echo?q=1`, {
      method: "POST",
      body: "payload",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
        Origin: "https://t3n.example",
        Referer: "https://t3n.example/chat",
        Cookie: "CF_Authorization=browser",
        "Cf-Access-Jwt-Assertion": "jwt",
        "Cf-Ray": "ray",
        "X-Forwarded-Host": "t3n.example",
        "X-Forwarded-Proto": "https",
        "X-Real-IP": "203.0.113.1",
      },
    });

    expect(response.status).toBe(201);
    expect(response.body).toBe("from backend");
    expect(response.headers["set-cookie"]).toBeUndefined();
    const [seen] = backend.seen;
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe("/api/echo?q=1");
    expect(seen?.body).toBe("payload");
    expect(seen?.headers).toMatchObject({
      host: backend.host,
      origin: backend.origin,
      authorization: "Bearer token",
      "content-type": "application/json",
    });
    for (const name of [
      "cookie",
      "referer",
      "cf-access-jwt-assertion",
      "cf-ray",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
    ]) {
      expect(seen?.headers[name]).toBeUndefined();
    }
  });

  it("keeps redirects back to a backend on the gateway", async () => {
    const backend = await startBackend();
    const gateway = await startGateway({ upstreams: [backend.origin] });

    const response = await send(`${gateway}/__t3code/gateway/${backend.host}/moved`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`/__t3code/gateway/${backend.host}/api/next?page=2`);
  });

  it("refuses backends outside the allowlist and requests without access", async () => {
    const backend = await startBackend();
    const open = await startGateway({ upstreams: [TAILNET_BACKEND] });
    const closed = await startGateway({ upstreams: [backend.origin], access: async () => false });

    expect((await send(`${open}/__t3code/gateway/${backend.host}/api/x`)).status).toBe(404);
    expect((await send(`${closed}/__t3code/gateway/${backend.host}/api/x`)).status).toBe(403);
    expect(await upgrade(`${closed}/__t3code/gateway/${backend.host}/ws`, "hi")).toEqual({
      upgraded: false,
      status: 403,
    });
    expect(backend.seen).toEqual([]);
  });

  it("joins a WebSocket upgrade to the backend and copies bytes both ways", async () => {
    const backend = await startBackend();
    const gateway = await startGateway({ upstreams: [backend.origin] });

    const result = await upgrade(
      `${gateway}/__t3code/gateway/${backend.host}/ws?wsTicket=t`,
      "ping",
    );

    expect(result).toMatchObject({ upgraded: true, reply: "ping" });
    if (result.upgraded) {
      expect(result.headers["sec-websocket-accept"]).toBe("accepted");
      expect(result.headers["set-cookie"]).toBeUndefined();
    }
    const [seen] = backend.seen;
    expect(seen?.url).toBe("/ws?wsTicket=t");
    expect(seen?.headers).toMatchObject({
      host: backend.host,
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    });
    expect(seen?.headers.cookie).toBeUndefined();
  });

  it("passes on a backend's refusal to upgrade", async () => {
    const backend = await startBackend();
    const gateway = await startGateway({ upstreams: [backend.origin] });

    expect(
      await upgrade(`${gateway}/__t3code/gateway/${backend.host}/ws?wsTicket=expired`, "ping"),
    ).toEqual({ upgraded: false, status: 401 });
  });
});

describe("gateway browser scripts", () => {
  async function clientScript() {
    const gateway = await startGateway({ upstreams: [TAILNET_BACKEND] });
    const html = (await send(`${gateway}/`)).body;
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf('<script src="/assets/app.js">'));
    return html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  }

  function runClient(
    source: string,
    input: { readonly controlled: boolean; readonly storage?: Map<string, string> },
  ) {
    const storage = input.storage ?? new Map<string, string>();
    const registrations: unknown[][] = [];
    let reloads = 0;
    class BrowserWebSocket {
      readonly url: string;
      constructor(url: string) {
        this.url = url;
      }
    }
    const context = NodeVM.createContext({
      URL,
      console,
      location: { href: "https://t3n.example/chat/1", reload: () => (reloads += 1) },
      navigator: {
        serviceWorker: {
          controller: input.controlled ? {} : null,
          ready: Promise.resolve(),
          register: async (...args: unknown[]) => void registrations.push(args),
        },
      },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      WebSocket: BrowserWebSocket,
    });
    context.window = context;
    NodeVM.runInContext(source, context);
    const WebSocket = context.WebSocket as new (url: string) => BrowserWebSocket;
    return { WebSocket, registrations, reloads: () => reloads };
  }

  it("sends the app's backend sockets to the gateway and installs the worker", async () => {
    const page = runClient(await clientScript(), { controlled: true });

    expect(new page.WebSocket("wss://mudd.example.ts.net:35338/ws?wsTicket=t").url).toBe(
      "wss://t3n.example/__t3code/gateway/mudd.example.ts.net:35338/ws?wsTicket=t",
    );
    expect(new page.WebSocket("wss://elsewhere.example/ws").url).toBe("wss://elsewhere.example/ws");
    expect(page.registrations).toEqual([[GATEWAY_WORKER_PATH, { scope: "/" }]]);
  });

  it("reloads a page the worker does not control, but never twice in a row", async () => {
    const source = await clientScript();
    const storage = new Map<string, string>();
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    const firstVisit = runClient(source, { controlled: false, storage });
    await settle();
    expect(firstVisit.reloads()).toBe(1);

    // The browser still did not hand the reloaded page to the worker.
    const stillOutside = runClient(source, { controlled: false, storage });
    await settle();
    expect(stillOutside.reloads()).toBe(0);

    runClient(source, { controlled: true, storage });
    const hardReload = runClient(source, { controlled: false, storage });
    await settle();
    expect(hardReload.reloads()).toBe(1);
  });

  /** Runs the served worker with `answer` standing in for the gateway's reply. */
  async function loadWorker(
    answer: () => Pick<Response, "status" | "statusText" | "headers" | "body">,
  ) {
    const gateway = await startGateway({ upstreams: [TAILNET_BACKEND] });
    const served = await send(`${gateway}${GATEWAY_WORKER_PATH}`);
    expect(served.headers["service-worker-allowed"]).toBe("/");

    const listeners = new Map<string, (event: unknown) => void>();
    const fetches: Array<{ url: string; init: RequestInit }> = [];
    const context = NodeVM.createContext({
      URL,
      Response,
      self: {
        location: new URL(`https://t3n.example${GATEWAY_WORKER_PATH}`),
        addEventListener: (type: string, listener: (event: unknown) => void) =>
          listeners.set(type, listener),
        skipWaiting: async () => {},
      },
      fetch: async (url: string, init: RequestInit) => {
        fetches.push({ url, init });
        return answer();
      },
    });
    NodeVM.runInContext(served.body, context);
    const dispatch = (request: Request) => {
      let responded: Promise<Response> | null = null;
      listeners.get("fetch")?.({
        request,
        respondWith: (response: Promise<Response>) => {
          responded = response;
        },
      });
      return responded as Promise<Response> | null;
    };
    return { dispatch, fetches };
  }

  it("routes allowlisted requests through the gateway with the access cookie", async () => {
    const { dispatch, fetches } = await loadWorker(
      () => new Response("partial", { status: 206, headers: { "Content-Range": "bytes 0-6/9" } }),
    );

    const response = await dispatch(
      new Request(`${TAILNET_BACKEND}/api/assets/token/clip.mp4`, {
        method: "POST",
        body: "bytes",
        headers: { Authorization: "Bearer token", Range: "bytes=0-6" },
      }),
    );

    expect(response?.status).toBe(206);
    expect(response?.url).toBe("");
    expect(await response?.text()).toBe("partial");
    const [forwarded] = fetches;
    expect(forwarded?.url).toBe(
      "https://t3n.example/__t3code/gateway/mudd.example.ts.net:35338/api/assets/token/clip.mp4",
    );
    expect(forwarded?.init.credentials).toBe("same-origin");
    expect(forwarded?.init.method).toBe("POST");
    expect(Buffer.from(forwarded?.init.body as ArrayBuffer).toString("utf8")).toBe("bytes");
    expect(new Headers(forwarded?.init.headers).get("authorization")).toBe("Bearer token");
    expect(dispatch(new Request("https://t3n.example/__t3code/shared-catalog"))).toBeNull();
  });

  it("passes on a bodiless status that the browser gave an empty body stream", async () => {
    // Firefox does this for the 204 that answers an attachment upload.
    const { dispatch } = await loadWorker(() => ({
      status: 204,
      statusText: "No Content",
      headers: new Headers(),
      body: new ReadableStream(),
    }));

    const response = await dispatch(
      new Request(`${TAILNET_BACKEND}/api/attachments/upload/token`, {
        method: "POST",
        body: "png",
      }),
    );

    expect(response?.status).toBe(204);
    expect(response?.body).toBeNull();
  });
});

describe("turning the gateway off", () => {
  it("leaves the app shell alone and makes installed workers remove themselves", async () => {
    const gateway = await startGateway({ upstreams: [] });
    expect((await send(`${gateway}/`)).body).not.toContain("<script>");
    const served = await send(`${gateway}${GATEWAY_WORKER_PATH}`);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toContain("javascript");

    const listeners = new Map<string, (event: unknown) => void>();
    const navigated: string[] = [];
    let unregistered = false;
    NodeVM.runInContext(
      served.body,
      NodeVM.createContext({
        self: {
          addEventListener: (type: string, listener: (event: unknown) => void) =>
            listeners.set(type, listener),
          skipWaiting: async () => {},
          registration: {
            unregister: async () => {
              unregistered = true;
              return true;
            },
          },
          clients: {
            matchAll: async () => [
              {
                url: "https://t3n.example/chat/1",
                navigate: async (url: string) => navigated.push(url),
              },
            ],
          },
        },
      }),
    );
    let activation: Promise<unknown> = Promise.resolve();
    listeners.get("activate")?.({
      waitUntil: (work: Promise<unknown>) => {
        activation = work;
      },
    });
    await activation;

    expect(listeners.has("fetch")).toBe(false);
    expect(unregistered).toBe(true);
    expect(navigated).toEqual(["https://t3n.example/chat/1"]);
  });
});
