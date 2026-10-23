// @effect-diagnostics nodeBuiltinImport:off - The bridge's listeners are a Node HTTP boundary.
/* oxlint-disable t3code/no-raw-mcp-registration -- The bridge is its own MCP server, outside apps/server; Cloudflare Access is its perimeter. */
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpProtocol, McpServer } from "effect/ai";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as Socket from "effect/socket/Socket";

import packageJson from "../package.json" with { type: "json" };
import * as Admin from "./admin.ts";
import { RequireAccess } from "./cloudflareAccess.ts";
import * as Environment from "./environment.ts";
import * as Registry from "./registry.ts";
import { BridgeToolkit, BridgeToolkitHandlersLive } from "./tools.ts";

export interface Listener {
  readonly host: string;
  readonly port: number;
}

/**
 * Serves one app on one listener. Each app is built with its own router:
 * `HttpRouter.serve` shares a memoized router across the layer graph, which
 * would expose the admin routes on the public MCP port.
 */
const serveOn = <A, E, R>(listener: Listener, app: Layer.Layer<A, E, R>) =>
  HttpRouter.toHttpEffect(app).pipe(
    Effect.map((handler) => HttpServer.serve(handler)),
    Layer.unwrap,
    HttpServer.withLogAddress,
    Layer.provide(
      NodeHttpServer.layer(NodeHttp.createServer, { host: listener.host, port: listener.port }),
    ),
  );

export const layer = (options: {
  readonly dataDir: string;
  readonly mcp: Listener;
  readonly admin: Listener;
}) => {
  const tools = McpServer.toolkit(BridgeToolkit).pipe(
    Layer.provide(BridgeToolkitHandlersLive),
    Layer.provide(Environment.layer),
  );
  const transport = McpServer.layerHttp({
    name: "T3 Code",
    version: packageJson.version,
    path: "/mcp",
    protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_11_25, McpProtocol.v2025_03_26],
  }).pipe(Layer.provide(RequireAccess));
  const mcp = serveOn(options.mcp, tools.pipe(Layer.provideMerge(transport)));
  const admin = serveOn(
    options.admin,
    Admin.layer(`http://${options.mcp.host}:${options.mcp.port}`),
  );
  return Layer.mergeAll(mcp, admin).pipe(
    Layer.provide(Registry.layer(options.dataDir)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
};
