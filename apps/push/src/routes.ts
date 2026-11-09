// @effect-diagnostics nodeBuiltinImport:off -- Effect has no constant-time comparison.
import * as NodeCrypto from "node:crypto";

import {
  RelayAgentActivityPublishRequest,
  RelayAgentActivitySnapshotResponse,
  RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
  RelayDeviceUnregistrationParams,
  RelayLiveActivityRegistrationRequest,
  RelayOkResponse,
  RelayPublishResponse,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpRouter from "effect/http/HttpRouter";
import type * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as Push from "./Push.ts";
import type * as PushStore from "./PushStore.ts";

export interface Tokens {
  /** Fleet hosts publish with this one. */
  readonly host: Redacted.Redacted<string>;
  /** The owner's phones register with this one. */
  readonly phone: Redacted.Redacted<string>;
}

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();

function bearerMatches(header: string | undefined, token: Redacted.Redacted<string>): boolean {
  const presented = /^Bearer (.+)$/i.exec(header ?? "")?.[1] ?? "";
  // Equal-length digests let timingSafeEqual compare without leaking the token's length.
  return (
    NodeCrypto.timingSafeEqual(digest(presented), digest(Redacted.value(token))) && presented !== ""
  );
}

const error = (status: number, code: string) =>
  HttpServerResponse.jsonUnsafe({ error: code }, { status });

const okResponse = HttpServerResponse.schemaJson(RelayOkResponse);
const ok = okResponse({ ok: true });

const PublishParams = Schema.Struct({
  environmentId: RelayAgentActivityState.fields.environmentId,
  threadId: RelayAgentActivityState.fields.threadId,
});

type HandlerError =
  | Schema.SchemaError
  | HttpServerError.HttpServerError
  | HttpBody.HttpBodyError
  | PushStore.PushStoreError;

/** The relay's agent-activity and mobile endpoints, behind a bearer token each instead of DPoP. */
export const layer = (tokens: Tokens) => {
  const guarded =
    (token: Redacted.Redacted<string>) =>
    <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, HandlerError, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!bearerMatches(request.headers.authorization, token)) {
          return error(401, "unauthorized");
        }
        return yield* handler.pipe(
          Effect.catchTags({
            SchemaError: () => Effect.succeed(error(400, "invalid_request")),
            HttpServerError: () => Effect.succeed(error(400, "invalid_request")),
            HttpBodyError: () => Effect.succeed(error(500, "internal_error")),
            PushStoreError: () => Effect.succeed(error(500, "internal_error")),
          }),
        );
      });
  const host = guarded(tokens.host);
  const phone = guarded(tokens.phone);

  return Layer.mergeAll(
    HttpRouter.add("GET", "/healthz", HttpServerResponse.jsonUnsafe({ ok: true })),
    HttpRouter.add(
      "POST",
      "/v1/environments/:environmentId/threads/:threadId/agent-activity",
      host(
        Effect.gen(function* () {
          const push = yield* Push.Push;
          const params = yield* HttpRouter.schemaPathParams(PublishParams);
          // The proof is the relay's environment signature; the host token stands in for it.
          const { state } = yield* HttpServerRequest.schemaBodyJson(
            RelayAgentActivityPublishRequest,
          );
          if (
            state !== null &&
            (state.environmentId !== params.environmentId || state.threadId !== params.threadId)
          ) {
            return error(400, "state_does_not_match_path");
          }
          const response = yield* push.publish({ ...params, state });
          return yield* HttpServerResponse.schemaJson(RelayPublishResponse)(response);
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/v1/mobile/devices",
      phone(
        Effect.gen(function* () {
          const push = yield* Push.Push;
          yield* push.registerDevice(
            yield* HttpServerRequest.schemaBodyJson(RelayDeviceRegistrationRequest),
          );
          return yield* ok;
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/v1/mobile/live-activities",
      phone(
        Effect.gen(function* () {
          const push = yield* Push.Push;
          yield* push.registerLiveActivity(
            yield* HttpServerRequest.schemaBodyJson(RelayLiveActivityRegistrationRequest),
          );
          return yield* ok;
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/v1/mobile/agent-activity",
      phone(
        Effect.gen(function* () {
          const push = yield* Push.Push;
          return yield* HttpServerResponse.schemaJson(RelayAgentActivitySnapshotResponse)(
            yield* push.snapshot,
          );
        }),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      "/v1/mobile/devices/:deviceId",
      phone(
        Effect.gen(function* () {
          const push = yield* Push.Push;
          const { deviceId } = yield* HttpRouter.schemaPathParams(RelayDeviceUnregistrationParams);
          yield* push.unregisterDevice(deviceId);
          return yield* ok;
        }),
      ),
    ),
  );
};
