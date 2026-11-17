import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import { expect } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import {
  applyUpstreamPreview,
  EMPTY_WHISPER_PREVIEW,
  makeWhisperSpeechStream,
  whisperPreviewText,
} from "./whisperStream.ts";

type Upstream = {
  /** Events the endpoint received, in order. */
  readonly received: Array<Record<string, unknown>>;
  connections: number;
};

/** A realtime transcription endpoint that answers like the WeType-backed service. */
const serveUpstream = Effect.fn("test.whisperStream.serveUpstream")(function* (
  upstream: Upstream,
  reply: (event: Record<string, unknown>) => ReadonlyArray<object>,
) {
  const moved = HttpRouter.add(
    "GET",
    "/v1/moved",
    Effect.succeed(
      HttpServerResponse.empty({ status: 307, headers: { location: "/v1/realtime" } }),
    ),
  );
  const realtime = HttpRouter.add(
    "GET",
    "/v1/realtime",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      upstream.connections++;
      if (request.headers.authorization !== "Bearer good-key")
        return HttpServerResponse.empty({ status: 401 });
      const socket = yield* request.upgrade;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const write = yield* socket.writer;
          const reader = yield* socket.reader;
          while (true) {
            for (const frame of yield* reader.pull) {
              const event = JSON.parse(String(frame)) as Record<string, unknown>;
              upstream.received.push(event);
              for (const answer of reply(event)) yield* write.write(JSON.stringify(answer));
              if (event.type === "input_audio_buffer.commit")
                yield* write.write(new Socket.CloseEvent(1000));
            }
          }
        }),
      ).pipe(Effect.ignore);
      return HttpServerResponse.empty();
    }),
  );
  yield* Layer.build(
    HttpRouter.serve(Layer.mergeAll(moved, realtime), {
      disableLogger: true,
      disableListenLog: true,
    }),
  );
  const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
  return `ws://127.0.0.1:${address.port}/v1/realtime`;
});

// Settings accept only wss://; the fixture serves plain ws:// on loopback.
const startStream = (streamingUrl: string, key: string, options = {}) =>
  Effect.gen(function* () {
    return yield* makeWhisperSpeechStream(
      yield* ServerSettings.ServerSettingsService,
      yield* SecretResolver.SecretResolver,
      { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, ...options },
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            cloudSpeechWhisper: {
              url: "https://asr.test/v1/audio/transcriptions",
              model: "whisper-1",
              streamingUrl,
            },
            cloudSpeechCredentials: {
              ...DEFAULT_SERVER_SETTINGS.cloudSpeechCredentials,
              whisper: key,
            },
          }),
        }),
        Layer.mock(SecretResolver.SecretResolver)({ invalidate: () => Effect.void }),
      ),
    ),
  );

const pcm = (...samples: number[]) => new Uint8Array(new Float32Array(samples).buffer);

it.live("relays captured audio as PCM16 and corrects the final transcript like batch", () =>
  Effect.gen(function* () {
    const upstream: Upstream = { received: [], connections: 0 };
    const url = yield* serveUpstream(upstream, (event) =>
      event.type === "transcription_session.update"
        ? [{ type: "transcription_session.created" }]
        : event.type === "input_audio_buffer.commit"
          ? [
              { type: "conversation.item.input_audio_transcription.delta", delta: "um hello" },
              {
                type: "conversation.item.input_audio_transcription.completed",
                transcript: "um hello when shuan",
              },
            ]
          : [],
    );
    const stream = yield* startStream(url, "good-key", {
      speechLanguage: "en",
      speechCustomWords: [{ term: "Wenxuan", aliases: ["when shuan"] }],
    });
    yield* stream.feed(pcm(0.5, -0.5));
    yield* stream.feed(pcm(1, -1));
    expect(yield* stream.finish).toBe("hello Wenxuan");
    expect(upstream.received).toEqual([
      {
        type: "transcription_session.update",
        session: {
          input_audio_format: "pcm16",
          input_audio_sample_rate: 16_000,
          include_partials: true,
          language: "en",
          prompt: "Wenxuan",
        },
      },
      {
        type: "input_audio_buffer.append",
        audio: Buffer.from(new Int16Array([16384, -16384]).buffer).toString("base64"),
      },
      {
        type: "input_audio_buffer.append",
        audio: Buffer.from(new Int16Array([32767, -32768]).buffer).toString("base64"),
      },
      { type: "input_audio_buffer.commit" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("maps a refused key and an upstream rate limit, and needs a streaming URL", () =>
  Effect.gen(function* () {
    const upstream: Upstream = { received: [], connections: 0 };
    const url = yield* serveUpstream(upstream, (event) =>
      event.type === "transcription_session.update"
        ? [{ type: "transcription_session.created" }]
        : event.type === "input_audio_buffer.append"
          ? [{ type: "error", error: { code: "rate_limited", message: "slow down" } }]
          : [],
    );
    expect(yield* Effect.flip(startStream("", "good-key"))).toMatchObject({
      reason: "missing-key",
    });
    expect(upstream.connections).toBe(0);
    expect(yield* Effect.flip(startStream(url, "wrong-key"))).toMatchObject({
      reason: "rejected-key",
    });
    // The key travels on the upgrade, so a redirect must not take it anywhere.
    const before = upstream.connections;
    expect(
      yield* Effect.flip(startStream(url.replace("/v1/realtime", "/v1/moved"), "good-key")),
    ).toMatchObject({ reason: "unavailable" });
    expect(upstream.connections).toBe(before);
    const stream = yield* startStream(url, "good-key");
    yield* stream.feed(pcm(0.25));
    expect(yield* Effect.flip(stream.finish)).toMatchObject({ reason: "rate-limit" });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it("previews partials in place of earlier text and falls back to deltas without them", () => {
  const words = [{ term: "Wenxuan", aliases: ["when shuan"] }];
  const partial = (text: string) => ({
    type: "conversation.item.input_audio_transcription.partial",
    text,
  });
  const delta = (text: string) => ({
    type: "conversation.item.input_audio_transcription.delta",
    delta: text,
  });
  const steps: ReadonlyArray<
    [Parameters<typeof applyUpstreamPreview>[1], { committed: string; tentative: string } | null]
  > = [
    [{ type: "transcription_session.created" }, null],
    [partial("hello when"), { committed: "", tentative: "hello when" }],
    [partial("hello when shuan"), { committed: "", tentative: "hello Wenxuan" }],
    // A revision may shorten the text; it still replaces the previous preview.
    [partial("hello"), { committed: "", tentative: "hello" }],
    [delta("hello world."), { committed: "hello world.", tentative: "" }],
    [partial("hello world. next"), { committed: "hello world.", tentative: " next" }],
    [partial("hallo world. next"), { committed: "", tentative: "hallo world. next" }],
  ];
  let preview = EMPTY_WHISPER_PREVIEW;
  for (const [event, expected] of steps) {
    const before = preview.revision;
    preview = applyUpstreamPreview(preview, event);
    expect(whisperPreviewText(preview, words)).toEqual(expected);
    expect(preview.revision).toBeGreaterThanOrEqual(before);
  }

  let deltasOnly = EMPTY_WHISPER_PREVIEW;
  for (const text of ["好，那我们", "现在开始", " and then"])
    deltasOnly = applyUpstreamPreview(deltasOnly, delta(text));
  expect(whisperPreviewText(deltasOnly, [])).toEqual({
    committed: "好，那我们现在开始 and then",
    tentative: "",
  });
  expect(deltasOnly.revision).toBe(3);
});
