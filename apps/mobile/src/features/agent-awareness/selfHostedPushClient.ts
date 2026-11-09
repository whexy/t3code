import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  RelayAgentActivitySnapshotResponse,
  RelayOkResponse,
  type RelayDeviceRegistrationRequest,
  type RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

// t3-push serves the relay's mobile endpoints with a plain bearer: no DPoP token exchange.
export const layer = (pushUrl: string) =>
  Layer.effect(
    ManagedRelay.ManagedRelayClient,
    Effect.gen(function* () {
      const managed = yield* ManagedRelay.ManagedRelayClient;
      const http = HttpClient.mapRequest(
        yield* HttpClient.HttpClient,
        HttpClientRequest.prependUrl(pushUrl),
      );

      // Each client method below owns the span.
      const send = Effect.fnUntraced(function* <
        S extends Schema.Constraint & { readonly DecodingServices: never },
      >(
        request: HttpClientRequest.HttpClientRequest,
        token: string,
        success: S,
        action: ManagedRelay.ManagedRelayRequestAction,
        activity: ManagedRelay.ManagedRelayRequestActivity,
      ) {
        return yield* http.execute(HttpClientRequest.bearerToken(request, token)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(success)),
          Effect.mapError(
            (cause) => new ManagedRelay.ManagedRelayRequestFailedError({ action, cause }),
          ),
          Effect.timeoutOrElse({
            duration: ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new ManagedRelay.ManagedRelayRequestTimeoutError({
                  activity,
                  timeoutMs: ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS,
                  traceId: null,
                }),
              ),
          }),
        );
      });

      return ManagedRelay.ManagedRelayClient.of({
        ...managed,
        registerDevice: Effect.fn("SelfHostedPush.registerDevice")(function* (input: {
          readonly clerkToken: string;
          readonly payload: RelayDeviceRegistrationRequest;
        }) {
          return yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post("/v1/mobile/devices"),
              input.payload,
            ),
            input.clerkToken,
            RelayOkResponse,
            "register relay mobile device",
            "Relay mobile device registration",
          );
        }),
        registerLiveActivity: Effect.fn("SelfHostedPush.registerLiveActivity")(function* (input: {
          readonly clerkToken: string;
          readonly payload: RelayLiveActivityRegistrationRequest;
        }) {
          return yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post("/v1/mobile/live-activities"),
              input.payload,
            ),
            input.clerkToken,
            RelayOkResponse,
            "register relay live activity",
            "Relay Live Activity registration",
          );
        }),
        getAgentActivitySnapshot: Effect.fn("SelfHostedPush.getAgentActivitySnapshot")(
          function* (input: { readonly clerkToken: string }) {
            return yield* send(
              HttpClientRequest.get("/v1/mobile/agent-activity"),
              input.clerkToken,
              RelayAgentActivitySnapshotResponse,
              "read relay agent activity snapshot",
              "Relay agent activity snapshot",
            );
          },
        ),
        unregisterDevice: Effect.fn("SelfHostedPush.unregisterDevice")(function* (input: {
          readonly clerkToken: string;
          readonly deviceId: string;
        }) {
          return yield* send(
            HttpClientRequest.delete(`/v1/mobile/devices/${encodeURIComponent(input.deviceId)}`),
            input.clerkToken,
            RelayOkResponse,
            "unregister relay mobile device",
            "Relay mobile device unregistration",
          );
        }),
      });
    }),
  );
