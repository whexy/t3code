// @effect-diagnostics nodeBuiltinImport:off -- The service's listener is a Node HTTP boundary.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

import * as ApnsClient from "../../../infra/relay/src/agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "../../../infra/relay/src/agentActivity/ApnsProviderTokens.ts";
import * as Http2Client from "./Http2Client.ts";
import * as Push from "./Push.ts";
import * as PushStore from "./PushStore.ts";
import * as Routes from "./routes.ts";

class MissingApnsKey extends Schema.TaggedError<MissingApnsKey>()("MissingApnsKey", {}) {
  override get message(): string {
    return "Set APNS_PRIVATE_KEY (the .p8 PEM) or APNS_PRIVATE_KEY_FILE (its path).";
  }
}

const secret = (name: string) => Config.schema(Schema.Redacted(Schema.NonEmptyString), name);

const settings = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const env = yield* Config.all({
    port: Config.Port("PORT").pipe(Config.withDefault(8080)),
    dataDir: Config.NonEmptyString("DATA_DIR"),
    hostToken: secret("HOST_TOKEN"),
    phoneToken: secret("PHONE_TOKEN"),
    teamId: Config.NonEmptyString("APNS_TEAM_ID"),
    keyId: Config.NonEmptyString("APNS_KEY_ID"),
    privateKey: Config.option(secret("APNS_PRIVATE_KEY")),
    privateKeyFile: Config.option(Config.NonEmptyString("APNS_PRIVATE_KEY_FILE")),
    defaultBundleId: Config.option(Config.NonEmptyString("APNS_DEFAULT_BUNDLE_ID")),
  });
  const privateKey = Option.isSome(env.privateKey)
    ? env.privateKey.value
    : Option.isSome(env.privateKeyFile)
      ? Redacted.make(yield* fileSystem.readFileString(env.privateKeyFile.value))
      : yield* new MissingApnsKey();
  return {
    ...env,
    apns: {
      teamId: env.teamId,
      keyId: env.keyId,
      privateKey,
      defaultBundleId: Option.getOrNull(env.defaultBundleId),
    },
  };
});

const server = Effect.gen(function* () {
  const config = yield* settings;
  const app = Routes.layer({ host: config.hostToken, phone: config.phoneToken });
  const http = HttpRouter.toHttpEffect(app).pipe(
    Effect.map((handler) => HttpServer.serve(handler)),
    Layer.unwrap,
    HttpServer.withLogAddress,
    Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, { port: config.port })),
  );
  return Layer.mergeAll(http, Push.sweepLayer).pipe(
    Layer.provideMerge(Push.layer(config.apns)),
    Layer.provide(ApnsClient.layer),
    Layer.provide(Layer.mergeAll(ApnsProviderTokens.layer, Http2Client.layer)),
    Layer.provide(PushStore.layer(NodePath.join(config.dataDir, "push.sqlite"))),
  );
});

// runMain interrupts on SIGTERM: the listener closes and the database with it.
server.pipe(Layer.unwrap, Layer.launch, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
