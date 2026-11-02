import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";

import { CloudflareAccess } from "./cloudflareAccess.ts";
import * as Server from "./server.ts";

const ASSERTION = "assertion-from-access";
/** Stands in for Access: only `ASSERTION` verifies. */
const access = Layer.succeed(
  CloudflareAccess,
  CloudflareAccess.of({ verify: (assertion) => Effect.succeed(assertion === ASSERTION) }),
);
const decodeTools = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    }),
  ),
);
const decodeCall = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        isError: Schema.Boolean,
        content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
      }),
    }),
  ),
);
const responseData = (body: string) =>
  body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6) ?? body;
const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Unknown),
    }),
  ),
);

const statusOf = (url: string) =>
  HttpClient.get(url).pipe(Effect.map((response) => response.status));
const initialize = (endpoint: string, assertion?: string) =>
  HttpClient.execute(
    HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json, text/event-stream",
        ...(assertion === undefined ? {} : { "cf-access-jwt-assertion": assertion }),
      }),
      HttpClientRequest.bodyJsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    ),
  );

describe("bridge listeners", () => {
  it.effect("keeps the admin page off the public MCP listener", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const net = yield* NetService.NetService;
      const mcpPort = yield* net.reserveLoopbackPort();
      const adminPort = yield* net.reserveLoopbackPort();
      const dataDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* Layer.build(
        Server.layer({
          dataDir,
          mcp: { host: "127.0.0.1", port: mcpPort },
          admin: { host: "127.0.0.1", port: adminPort },
        }).pipe(Layer.provide(access)),
      );
      const mcp = `http://127.0.0.1:${mcpPort}`;
      const admin = `http://127.0.0.1:${adminPort}`;
      expect(yield* statusOf(`${admin}/`)).toBe(200);
      expect(yield* statusOf(`${admin}/mcp`)).toBe(404);
      expect(yield* statusOf(`${mcp}/`)).toBe(404);
      expect(yield* statusOf(`${mcp}/servers/pair`)).toBe(404);
      const endpoint = `${mcp}/mcp`;
      expect((yield* initialize(endpoint)).status).toBe(401);
      expect((yield* initialize(endpoint, "forged")).status).toBe(401);
      const initialized = yield* initialize(endpoint, ASSERTION);
      expect(initialized.status).toBe(200);
      yield* initialized.text;
      const request = (id: number, method: string, params: unknown) =>
        HttpClient.execute(
          HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.setHeaders({
              accept: "application/json, text/event-stream",
              "cf-access-jwt-assertion": ASSERTION,
              "mcp-session-id": initialized.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            }),
            HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id, method, params }),
          ),
        ).pipe(
          Effect.flatMap((response) => response.text),
          Effect.map(responseData),
        );
      const listed = decodeTools(yield* request(2, "tools/list", {}));
      expect(listed.result.tools.map((tool) => tool.name).sort()).toEqual([
        "control_session",
        "create_project",
        "create_session",
        "get_session_status",
        "get_usage",
        "inspect_project",
        "list_projects",
        "list_sessions",
        "read_session_message",
        "respond_to_session",
        "send_session_message",
      ]);
      const called = decodeCall(
        yield* request(3, "tools/call", {
          name: "create_project",
          arguments: { server_id: "missing", source: { type: "local", path: "/srv/app" } },
        }),
      );
      expect(called.result.isError).toBe(true);
      expect(called.result.content[0]?.text).toContain("Unknown server_id");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, FetchHttpClient.layer)),
    ),
  );
});

it.effect("discovers and calls get_usage through the MCP HTTP protocol", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const net = yield* NetService.NetService;
    const mcpPort = yield* net.reserveLoopbackPort();
    const adminPort = yield* net.reserveLoopbackPort();
    const dataDir = yield* fileSystem.makeTempDirectoryScoped();
    yield* Layer.build(
      Server.layer({
        dataDir,
        mcp: { host: "127.0.0.1", port: mcpPort },
        admin: { host: "127.0.0.1", port: adminPort },
      }).pipe(Layer.provide(access)),
    );
    const endpoint = `http://127.0.0.1:${mcpPort}/mcp`;
    const client = yield* HttpClient.HttpClient;
    const initialized = yield* client.post(endpoint, {
      headers: {
        accept: "application/json, text/event-stream",
        "cf-access-jwt-assertion": ASSERTION,
      },
      body: HttpBody.jsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "usage-test", version: "1" },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    yield* initialized.text;
    const sessionId = initialized.headers["mcp-session-id"]!;
    const call = Effect.fn("mcpTestCall")(function* (id: number, method: string, params: unknown) {
      const response = yield* client.post(endpoint, {
        headers: {
          accept: "application/json, text/event-stream",
          "cf-access-jwt-assertion": ASSERTION,
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.jsonUnsafe({ jsonrpc: "2.0", id, method, params }),
      });
      expect(response.status).toBe(200);
      const body = yield* response.text;
      const data = body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      return decodeResponse(data ?? body);
    });
    const listed = yield* call(2, "tools/list", {});
    expect(listed.result).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: "get_usage",
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
          inputSchema: expect.objectContaining({
            required: expect.arrayContaining(["since_day", "until_day", "time_zone"]),
          }),
        }),
      ]),
    });
    const usage = yield* call(3, "tools/call", {
      name: "get_usage",
      arguments: { since_day: "2026-09-01", until_day: "2026-09-30", time_zone: "UTC" },
    });
    expect(usage.result).toMatchObject({
      isError: false,
      structuredContent: { totals: { totalTokens: 0 }, servers: [], groups: [] },
    });
    const invalid = yield* call(4, "tools/call", {
      name: "get_usage",
      arguments: { since_day: "2026-09-31", until_day: "2026-09-30", time_zone: "UTC" },
    });
    expect(invalid.result).toMatchObject({ isError: true });
    yield* client.del(endpoint, {
      headers: { "cf-access-jwt-assertion": ASSERTION, "mcp-session-id": sessionId },
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, FetchHttpClient.layer)),
  ),
);
