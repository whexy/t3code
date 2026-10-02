import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import { describe, expect, it } from "@effect/vitest";

import {
  addServer,
  type BridgeState,
  type Pairing,
  Registry,
  layer,
  removeServer,
  repairServer,
  setPublicUrl,
  updateServer,
} from "./registry.ts";

const pairing = (environmentId: string, name: string, token = "token-1"): Pairing => ({
  environmentId,
  name,
  url: `https://${environmentId}.example.ts.net/`,
  token,
  pairedAt: "2026-09-28T12:00:00.000Z",
  expiresAt: "2026-10-28T12:00:00.000Z",
});

const empty: BridgeState = { secret: "s".repeat(48), publicUrl: null, servers: [] };

const ok = (result: Result.Result<BridgeState, string>) => {
  if (Result.isFailure(result)) throw new Error(result.failure);
  return result.success;
};
const failure = (result: Result.Result<BridgeState, string>) =>
  Result.isFailure(result) ? result.failure : null;

describe("server registry", () => {
  it("names a new server after its label unless an id is given", () => {
    const state = ok(addServer(empty, pairing("env-a", "Mac Studio")));
    expect(state.servers[0]).toMatchObject({ id: "mac-studio", enabled: true });
    expect(ok(addServer(empty, pairing("env-a", "Mac Studio"), "studio")).servers[0]?.id).toBe(
      "studio",
    );
  });

  it("refuses a second pairing of the same server or a taken id", () => {
    const state = ok(addServer(empty, pairing("env-a", "Mac Studio")));
    expect(failure(addServer(state, pairing("env-a", "Mac Studio")))).toContain(
      'already paired as "mac-studio"',
    );
    expect(failure(addServer(state, pairing("env-b", "Laptop"), "mac-studio"))).toContain(
      "already in use",
    );
    expect(failure(addServer(state, pairing("env-b", "Laptop"), "Bad Id"))).toContain(
      "not a valid server id",
    );
  });

  it("re-pairs only from the same server and keeps the id and enabled flag", () => {
    const disabled = ok(
      updateServer(ok(addServer(empty, pairing("env-a", "Studio"))), "studio", {
        enabled: false,
      }),
    );
    expect(failure(repairServer(disabled, "studio", pairing("env-b", "Laptop")))).toContain(
      "a different server",
    );
    const refreshed = ok(repairServer(disabled, "studio", pairing("env-a", "Studio", "token-2")));
    expect(refreshed.servers).toEqual([
      expect.objectContaining({ id: "studio", token: "token-2", enabled: false }),
    ]);
  });

  it("renames, disables, and removes servers", () => {
    const state = ok(
      addServer(ok(addServer(empty, pairing("env-a", "Studio"))), pairing("env-b", "Laptop")),
    );
    expect(failure(updateServer(state, "studio", { id: "laptop" }))).toContain("already in use");
    const renamed = ok(
      updateServer(state, "studio", { id: "desk", name: " Desk ", enabled: false }),
    );
    expect(renamed.servers[0]).toMatchObject({ id: "desk", name: "Desk", enabled: false });
    expect(ok(removeServer(renamed, "desk")).servers.map((server) => server.id)).toEqual([
      "laptop",
    ]);
  });

  it("keeps only the origin and path of the public URL", () => {
    expect(ok(setPublicUrl(empty, "https://t3-mcp.example.com/?x=1")).publicUrl).toBe(
      "https://t3-mcp.example.com",
    );
    expect(ok(setPublicUrl(empty, "  ")).publicUrl).toBeNull();
    expect(failure(setPublicUrl(empty, "ftp://example.com"))).toContain("https://");
  });

  it.effect("persists state privately and restores it on the next start", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped();
      const first = yield* Registry.pipe(Effect.provide(layer(dataDir)));
      const { secret } = yield* first.state;
      yield* first.update((state) => addServer(state, pairing("env-a", "Studio")));
      const file = yield* fileSystem.stat(`${dataDir}/state.json`);
      const restarted = yield* Registry.pipe(Effect.provide(layer(dataDir)));
      expect(secret).toMatch(/^[0-9a-f]{48}$/);
      expect(file.mode & 0o777).toBe(0o600);
      expect(yield* restarted.state).toMatchObject({
        secret,
        servers: [expect.objectContaining({ id: "studio" })],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
