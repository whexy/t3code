import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";

import { cli } from "../binCli.ts";
import * as ManagedPolicy from "./ManagedPolicy.ts";

// Release and nightly builds stamp a channel other than dev; the override must not depend on it.
vi.mock("../config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  telemetryChannel: "nightly",
}));

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

const loadPolicy = (env: Record<string, string>) =>
  ManagedPolicy.ManagedPolicy.pipe(
    Effect.provide(ManagedPolicy.layer),
    withEnv(env),
    Effect.provideService(HostProcess.Platform, "linux"),
  );

const runCli = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.gen(function* () {
    yield* Command.runWith(cli, { version: "0.0.0" })(args);
    return (yield* TestConsole.logLines).filter((line): line is string => typeof line === "string");
  }).pipe(
    withEnv(env),
    Effect.provide(Layer.mergeAll(NodeCrypto.layer, NetService.layer, TestConsole.layer)),
  );

const policyDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-policy-override-" });
  const file = path.join(dir, "policy.json");
  yield* fs.writeFileString(file, JSON.stringify({ schemaVersion: 1, organization: "Example" }));
  return { dir, file, missing: path.join(dir, "missing.json") };
});

it.layer(NodeServices.layer)("ManagedPolicy path override", (it) => {
  it.effect("replaces the machine policy in release builds", () =>
    Effect.gen(function* () {
      const { file, missing } = yield* policyDir;

      const policy = yield* loadPolicy({ [ManagedPolicy.pathOverrideVariable]: file });
      assert.equal(policy.path, file);
      assert.equal(policy.summary?.organization, "Example");

      // No file there means no policy, even when the machine has one.
      const unmanaged = yield* loadPolicy({ [ManagedPolicy.pathOverrideVariable]: missing });
      assert.equal(unmanaged.path, missing);
      assert.isUndefined(unmanaged.document);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the machine policy in charge when unset or empty", () =>
    Effect.gen(function* () {
      for (const env of [{}, { [ManagedPolicy.pathOverrideVariable]: " " }]) {
        assert.equal((yield* loadPolicy(env)).path, "/etc/t3code/policy.json");
      }
    }),
  );

  it.effect("policy show and check name the override file", () =>
    Effect.gen(function* () {
      const { dir, file, missing } = yield* policyDir;
      const named = (path: string) =>
        `${ManagedPolicy.pathOverrideVariable} names ${path} in place of this machine's policy.`;

      const shown = yield* runCli(["policy", "show", "--base-dir", dir], {
        [ManagedPolicy.pathOverrideVariable]: file,
      });
      assert.isTrue(shown.some((line) => line.startsWith(`Managed by Example (${file}`)));
      assert.include(shown, named(file));

      const absent = yield* runCli(["policy", "show", "--base-dir", dir], {
        [ManagedPolicy.pathOverrideVariable]: missing,
      });
      assert.isTrue(absent.some((line) => line.startsWith(`No policy file at ${missing}.`)));
      assert.include(absent, named(missing));

      const checked = yield* runCli(["policy", "check", file], {
        [ManagedPolicy.pathOverrideVariable]: missing,
      });
      assert.include(checked, named(missing));
    }).pipe(Effect.scoped),
  );
});
