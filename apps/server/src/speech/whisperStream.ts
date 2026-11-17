import {
  AuthOrchestrationOperateScope,
  CloudSpeechApiKey,
  CloudSpeechError,
  isSecretReference,
  SPEECH_CLOUD_WHISPER_STREAM_PATH,
  type SpeechStreamText,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { cloudSpeechLanguages, effectiveSpeechLanguage } from "@t3tools/shared/speech";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import { applySpeechAliases } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";
import { decodeSpeechPcm, MAX_SPEECH_BYTES, SpeechInvalidAudioError } from "./SpeechService.ts";
import { runSpeechSocket } from "./stream.ts";

const isApiKey = Schema.is(CloudSpeechApiKey);
const UpstreamEvent = Schema.Struct({
  type: Schema.String,
  delta: Schema.optionalKey(Schema.String),
  transcript: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeUpstreamEvent = Schema.decodeUnknownOption(Schema.fromJsonString(UpstreamEvent));

// `ws` reports the refused upgrade's status, which the global WebSocket hides, and like it
// never follows a redirect. Its unhandled `error` on an early close would exit the server.
const upstreamWebSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeWS.layerWebSocketConstructor));

const failure = (reason: CloudSpeechError["reason"]) =>
  new CloudSpeechError({ provider: "whisper", reason });

/** The upgrade's HTTP status, which `ws` reports only in its error message. */
function openFailure(error: Socket.SocketError) {
  const cause = error.reason._tag === "SocketOpenError" ? error.reason.cause : undefined;
  const status = /\b(\d{3})\b/.exec(String((cause as { message?: unknown })?.message ?? ""))?.[1];
  return failure(
    status === "401" || status === "403"
      ? "rejected-key"
      : status === "429"
        ? "rate-limit"
        : "unavailable",
  );
}

function pcm16Base64(bytes: Uint8Array) {
  const samples = decodeSpeechPcm(bytes);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    pcm.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), index * 2);
  }
  return pcm.toString("base64");
}

/**
 * Relays one recording to the Whisper endpoint's realtime socket while it is captured. Chunk
 * transcripts become the live preview; the final transcript gets the batch path's corrections.
 */
export const makeWhisperSpeechStream = Effect.fn("WhisperSpeechStream.start")(function* (
  settings: ServerSettings.ServerSettingsService["Service"],
  resolver: SecretResolver.SecretResolver["Service"],
  options: SpeechTranscriptionOptions,
) {
  const current = yield* settings.getSettings.pipe(Effect.mapError(() => failure("unavailable")));
  const source = current.cloudSpeechCredentials.whisper;
  const endpoint = current.cloudSpeechWhisper;
  if (!source || !endpoint.url || !endpoint.streamingUrl) return yield* failure("missing-key");
  // A vault that locked since the last recording must not authorize a new stream.
  if (isSecretReference(source)) yield* resolver.invalidate([source]);
  const key = yield* requireSettingsSecret(resolver, source).pipe(
    Effect.mapError(() => failure("unreadable-key")),
  );
  if (!isApiKey(key)) return yield* failure("unreadable-key");
  const language = effectiveSpeechLanguage(cloudSpeechLanguages, options.speechLanguage);
  const terms = options.speechCustomWords.map(({ term }) => term);

  const upstream = yield* Socket.makeWebSocket(endpoint.streamingUrl, {
    openTimeout: "10 seconds",
    headers: { authorization: `Bearer ${key}` },
  }).pipe(Effect.provide(upstreamWebSocketConstructor));
  const write = yield* upstream.writer;
  const reader = yield* upstream.reader.pipe(Effect.mapError(openFailure));
  const created = yield* Deferred.make<void, CloudSpeechError>();
  const completed = yield* Deferred.make<string, CloudSpeechError>();
  const chunks: string[] = [];
  const stop = (error: CloudSpeechError) =>
    Effect.all([Deferred.fail(created, error), Deferred.fail(completed, error)], {
      discard: true,
    });
  const handle = (frame: string | Uint8Array) => {
    const event = decodeUpstreamEvent(
      typeof frame === "string" ? frame : new TextDecoder().decode(frame),
    );
    if (Option.isNone(event)) return stop(failure("unavailable"));
    switch (event.value.type) {
      case "transcription_session.created":
        return Deferred.succeed(created, undefined);
      case "conversation.item.input_audio_transcription.delta":
        if (event.value.delta) chunks.push(event.value.delta);
        return Effect.void;
      case "conversation.item.input_audio_transcription.completed":
        return Deferred.succeed(completed, event.value.transcript ?? "");
      case "error":
        return stop(
          failure(event.value.error?.code === "rate_limited" ? "rate-limit" : "unavailable"),
        );
      default:
        return Effect.void;
    }
  };
  yield* Effect.gen(function* () {
    while (true) yield* Effect.forEach(yield* reader.pull, handle, { discard: true });
  }).pipe(
    // A close before the final transcript, normal or not, means no transcript is coming.
    Effect.catch(() => stop(failure("unavailable"))),
    Effect.forkScoped,
  );

  const sendEvent = (event: object) =>
    write.write(JSON.stringify(event)).pipe(Effect.mapError(() => failure("unavailable")));
  yield* sendEvent({
    type: "transcription_session.update",
    session: {
      input_audio_format: "pcm16",
      input_audio_sample_rate: 16_000,
      ...(language !== "auto" ? { language } : {}),
      ...(terms.length > 0 ? { prompt: terms.join(", ") } : {}),
    },
  });
  yield* Deferred.await(created).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(failure("unavailable")),
    }),
  );

  let byteLength = 0;
  // An upstream error during capture ends the recording now instead of at finish.
  const upstreamFailure = Deferred.poll(completed).pipe(
    Effect.flatMap((done) => (Option.isSome(done) ? done.value.pipe(Effect.asVoid) : Effect.void)),
  );
  return {
    feed: Effect.fn("WhisperSpeechStream.feed")(function* (bytes: Uint8Array) {
      yield* upstreamFailure;
      if (byteLength + bytes.byteLength > MAX_SPEECH_BYTES)
        return yield* new SpeechInvalidAudioError({
          byteLength: bytes.byteLength,
          message: "Speech stream audio limit exceeded.",
        });
      const audio = yield* Effect.try({
        try: () => pcm16Base64(bytes),
        catch: () =>
          new SpeechInvalidAudioError({
            byteLength: bytes.byteLength,
            message: "Invalid PCM audio.",
          }),
      });
      byteLength += bytes.byteLength;
      yield* sendEvent({ type: "input_audio_buffer.append", audio });
      // Deltas carry their own spacing; joined in order they are the transcript so far.
      const preview = applySpeechAliases(chunks.join(""), options.speechCustomWords);
      const text: SpeechStreamText | null = preview ? { committed: preview, tentative: "" } : null;
      return { revision: chunks.length, text };
    }),
    finish: Effect.gen(function* () {
      yield* sendEvent({ type: "input_audio_buffer.commit" });
      const transcript = yield* Deferred.await(completed).pipe(
        // The endpoint promises a transcript within 30 seconds of commit.
        Effect.timeoutOrElse({
          duration: "45 seconds",
          orElse: () => Effect.fail(failure("unavailable")),
        }),
      );
      const corrected = applySpeechAliases(transcript, options.speechCustomWords);
      return (
        options.speechRemoveFillerWords
          ? removeSpeechFillerWords(corrected, language, options.speechCorrectionWord)
          : corrected
      ).trim();
    }),
  };
});

export const whisperSpeechStreamRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    return HttpRouter.add(
      "GET",
      SPEECH_CLOUD_WHISPER_STREAM_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth
          .authenticateWebSocketUpgrade(request, "media")
          .pipe(Effect.result);
        if (session._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
        if (!session.success.scopes.includes(AuthOrchestrationOperateScope))
          return HttpServerResponse.empty({ status: 403 });
        const socket = yield* request.upgrade;
        yield* runSpeechSocket(socket, {
          startStream: (options: SpeechTranscriptionOptions) =>
            makeWhisperSpeechStream(settings, resolver, options),
        }).pipe(Effect.scoped);
        return HttpServerResponse.empty();
      }),
    );
  }),
).pipe(Layer.provide(SecretResolverLayer.layer));
