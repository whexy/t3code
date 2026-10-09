import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionState,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { check, pair, supportOf } from "./access.ts";
import { Environments, layer } from "./environment.ts";
import { Registry, type ServerRecord } from "./registry.ts";
import { callTool } from "./testing.ts";
import { BridgeToolkitHandlersLive } from "./tools.ts";

const descriptor = (
  serverVersion: string,
  orchestrationProtocolVersion?: number,
): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make("env"),
  label: "Server",
  platform: { os: "linux", arch: "x64" },
  serverVersion,
  ...(orchestrationProtocolVersion === undefined ? {} : { orchestrationProtocolVersion }),
  capabilities: { repositoryIdentity: true },
});
const encodeDescriptor = Schema.encodeSync(ExecutionEnvironmentDescriptor);
const encodeSession = Schema.encodeSync(AuthSessionState);

const record = (id: string): ServerRecord => ({
  id,
  name: id,
  environmentId: `env-${id}`,
  url: `https://${id}.example.test/`,
  token: "token",
  enabled: true,
  pairedAt: "2026-09-28T12:00:00.000Z",
  expiresAt: "2026-10-28T12:00:00.000Z",
});

const emptyShell = Schema.encodeSync(OrchestrationV2ShellSnapshot)({
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [],
  threads: [],
  archivedThreads: [],
});

/**
 * Paired servers reached over HTTP. `servers` maps each host to the descriptor
 * it serves, or null while it answers only with 503; tests change it to upgrade one.
 */
function pairedServers(servers: Map<string, ExecutionEnvironmentDescriptor | null>) {
  const httpClient = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const served = servers.get(url.hostname.split(".")[0]!);
      const response =
        served === null || served === undefined
          ? new Response(null, { status: 503 })
          : Response.json(
              url.pathname === "/.well-known/t3/environment"
                ? encodeDescriptor(served)
                : url.pathname === "/api/orchestration/shell"
                  ? emptyShell
                  : { authenticated: true },
            );
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const registry = Registry.of({
    state: Effect.succeed({
      secret: "secret",
      publicUrl: null,
      servers: [...servers.keys()].map(record),
    }),
    update: () => Effect.die("unused"),
    rotateSecret: Effect.die("unused"),
  });
  const services = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.succeed(Socket.WebSocketConstructor, () => {
      throw new Error("no sockets in this test");
    }),
  );
  return {
    services,
    environments: layer.pipe(
      Layer.provide(Layer.succeed(Registry, registry)),
      Layer.provide(services),
    ),
  };
}

const v1 = descriptor("0.0.45");
const v2 = descriptor("0.0.46", ORCHESTRATION_PROTOCOL_VERSION);

describe("orchestration protocol detection", () => {
  it("treats servers before protocol negotiation, and protocol 1, as too old", () => {
    expect(supportOf(v1)).toEqual({ status: "too_old", serverVersion: "0.0.45" });
    expect(supportOf(descriptor("0.0.45", 1))).toEqual({
      status: "too_old",
      serverVersion: "0.0.45",
    });
    expect(supportOf(v2)).toEqual({ status: "supported" });
  });

  it.effect("reports a too-old server on the admin page, and never guesses from a failure", () => {
    const fixture = pairedServers(
      new Map([
        ["old", v1],
        ["gone", null],
      ]),
    );
    return Effect.gen(function* () {
      expect(yield* check(record("old"))).toEqual({ status: "too_old", serverVersion: "0.0.45" });
      expect(yield* check(record("gone"))).toMatchObject({ status: "unreachable" });
    }).pipe(Effect.provide(fixture.services));
  });
});

const bridgePermissions = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthDiagnosticsReadScope,
  AuthSourceControlWriteScope,
];

/** A current server whose bridge token holds `permissions`, and which records token requests. */
function grantingServer(permissions: ReadonlyArray<AuthEnvironmentScope>) {
  const tokenRequests: Array<URLSearchParams> = [];
  const session = encodeSession({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
      serverUpdateScope: AuthEnvironmentMaintainScope,
    },
    scopes: [],
    permissions,
  });
  const httpClient = HttpClient.make((request, url) =>
    Effect.sync(() => {
      if (url.pathname === "/oauth/token" && request.body._tag === "Uint8Array") {
        tokenRequests.push(new URLSearchParams(new TextDecoder().decode(request.body.body)));
      }
      const body =
        url.pathname === "/.well-known/t3/environment"
          ? encodeDescriptor(v2)
          : url.pathname === "/oauth/token"
            ? {
                access_token: "token",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "Bearer",
                expires_in: 2_592_000,
                scope: permissions.join(" "),
              }
            : session;
      return HttpClientResponse.fromWeb(request, Response.json(body));
    }),
  );
  return { tokenRequests, services: Layer.succeed(HttpClient.HttpClient, httpClient) };
}

describe("bridge permissions", () => {
  it.effect("asks to read usage and change source control, and nothing broader", () => {
    const server = grantingServer(bridgePermissions);
    return Effect.gen(function* () {
      yield* pair("https://home.example.test/pair#token=pairing-token");
      expect(server.tokenRequests.map((body) => body.get("scope")?.split(" "))).toEqual([
        bridgePermissions,
      ]);
    }).pipe(Effect.provide(server.services));
  });

  it.effect(
    "flags a token paired before usage and source control had their own permissions",
    () => {
      const legacy = grantingServer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      const current = grantingServer(bridgePermissions);
      return Effect.gen(function* () {
        expect(yield* check(record("home")).pipe(Effect.provide(legacy.services))).toMatchObject({
          status: "connected",
          missing: [AuthDiagnosticsReadScope, AuthSourceControlWriteScope],
        });
        expect(yield* check(record("home")).pipe(Effect.provide(current.services))).toMatchObject({
          status: "connected",
          missing: [],
        });
      });
    },
  );
});

describe("environments on servers too old for the bridge", () => {
  it.effect("are hidden from listings and rejected by name, until the server is upgraded", () => {
    const servers = new Map<string, ExecutionEnvironmentDescriptor | null>([
      ["home", v2],
      ["work", v1],
    ]);
    const fixture = pairedServers(servers);
    return Effect.gen(function* () {
      const environments = yield* Environments;
      expect((yield* environments.enabled).map((environment) => environment.id)).toEqual(["home"]);
      const rejected = yield* Effect.flip(environments.get("work"));
      expect(rejected).toMatchObject({ code: "server_too_old" });
      expect(rejected.message).toContain("disabled automatically");
      expect(rejected.message).toContain("0.0.45");

      servers.set("work", descriptor("0.0.46", ORCHESTRATION_PROTOCOL_VERSION));
      expect((yield* environments.enabled).map((environment) => environment.id)).toEqual([
        "home",
        "work",
      ]);
      expect((yield* environments.get("work")).id).toBe("work");
    }).pipe(Effect.provide(fixture.environments));
  });

  it.effect("keeps an unreachable server listed, so its own call reports why", () => {
    const fixture = pairedServers(new Map([["home", null]]));
    return Effect.gen(function* () {
      const environments = yield* Environments;
      expect((yield* environments.enabled).map((environment) => environment.id)).toEqual(["home"]);
    }).pipe(Effect.provide(fixture.environments));
  });

  it.effect(
    "are skipped by tools that list every server and rejected by tools that name one",
    () => {
      const fixture = pairedServers(
        new Map([
          ["home", v2],
          ["work", v1],
        ]),
      );
      const tools = BridgeToolkitHandlersLive.pipe(
        Layer.provide(fixture.environments),
        Layer.provide(NodeServices.layer),
      );
      return Effect.gen(function* () {
        const listed = yield* callTool("list_sessions", {});
        expect(listed.servers.map((server) => server.server_id)).toEqual(["home"]);
        const error = yield* Effect.flip(
          callTool("get_session_status", { server_id: "work", session_id: "thread-1" }),
        );
        expect(error.message).toContain("too old for this bridge");
      }).pipe(Effect.provide(tools));
    },
  );
});
