import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command, Flag } from "effect/unstable/cli";

import packageJson from "../package.json" with { type: "json" };
import * as Server from "./server.ts";

const stringFlag = (name: string, env: string, fallback: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.withFallbackConfig(Config.String(env).pipe(Config.withDefault(fallback))),
  );

const portFlag = (name: string, env: string, fallback: number, description: string) =>
  Flag.Int(name).pipe(
    Flag.withDescription(description),
    Flag.withFallbackConfig(Config.Int(env).pipe(Config.withDefault(fallback))),
  );

const cli = Command.make("t3-mcp", {
  dataDir: stringFlag(
    "data-dir",
    "T3_MCP_DATA_DIR",
    "t3-mcp-data",
    "Directory for the bridge state: paired servers and the MCP secret.",
  ),
  host: stringFlag("host", "T3_MCP_HOST", "127.0.0.1", "Interface for the public MCP endpoint."),
  port: portFlag("port", "T3_MCP_PORT", 8787, "Port for the public MCP endpoint."),
  adminHost: stringFlag(
    "admin-host",
    "T3_MCP_ADMIN_HOST",
    "127.0.0.1",
    "Interface for the admin page. Keep it off the public internet.",
  ),
  adminPort: portFlag("admin-port", "T3_MCP_ADMIN_PORT", 8788, "Port for the admin page."),
}).pipe(
  Command.withDescription(
    "Headless T3 Code client that lets MCP clients such as ChatGPT start and follow coding sessions.",
  ),
  Command.withHandler((flags) =>
    Layer.launch(
      Server.layer({
        dataDir: flags.dataDir,
        mcp: { host: flags.host, port: flags.port },
        admin: { host: flags.adminHost, port: flags.adminPort },
      }),
    ),
  ),
);

Command.run(cli, { version: packageJson.version }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
