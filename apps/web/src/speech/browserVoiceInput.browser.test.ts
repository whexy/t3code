import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import { VoiceInputController } from "@t3tools/client-runtime/voice-input";
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  EnvironmentId,
  type EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import { decodeSpeechPcmRequest } from "@t3tools/shared/speech";
import { expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";
import { resolveAppleSpeechLocale } from "./appleSpeech";
import { createBrowserPcmCapture } from "./browserPcmCapture";
import {
  createAppleSpeechVoiceInputPlatform,
  createBrowserVoiceInputPlatform,
} from "./browserVoiceInput";

vi.mock("../connection/runtime", async () => {
  const [{ Atom }, { layerRemoteHttpClient }] = await Promise.all([
    import("effect/reactivity"),
    import("@t3tools/client-runtime/rpc"),
  ]);
  return {
    connectionAtomRuntime: Atom.runtime(
      layerRemoteHttpClient((input, init) => globalThis.fetch(input, init)),
    ),
  };
});

function capture() {
  let receive: ((event: { data: Float32Array | "stopped" }) => void) | undefined;
  const stopTrack = vi.fn();
  const workletOptions: Array<AudioWorkletNodeOptions | undefined> = [];
  const workletMessages: unknown[] = [];
  const resources = new DisposableStack();
  resources.use(
    stubGlobal(
      "AudioContext",
      class {
        audioWorklet = { addModule: async () => {} };
        createMediaStreamSource() {
          return { connect() {} };
        }
        resume = async () => {};
        close = async () => {};
      },
    ),
  );
  resources.use(
    stubGlobal(
      "AudioWorkletNode",
      class {
        constructor(_context: unknown, _name: string, options?: AudioWorkletNodeOptions) {
          workletOptions.push(options);
        }
        port = {
          set onmessage(handler: typeof receive) {
            receive = handler;
          },
          postMessage(message: unknown) {
            workletMessages.push(message);
            if (message === "stop") receive?.({ data: "stopped" });
          },
          close() {},
        };
        connect() {}
        disconnect() {}
      },
    ),
  );
  resources.use(
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue({
      getTracks: () => [{ stop: stopTrack, addEventListener() {} }],
    } as unknown as MediaStream),
  );
  return {
    feed: (data: Float32Array) => receive?.({ data }),
    stopTrack,
    workletOptions,
    workletMessages,
    [Symbol.dispose]: () => resources.dispose(),
  };
}

const target = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("remote-transcription"),
  label: "Remote transcription",
  connectionId: "remote",
});
const prepared = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: "https://transcription.example.test",
  socketUrl: "wss://transcription.example.test/ws",
  httpAuthorization: { _tag: "Bearer" as const, token: "audio-grant" },
};
const status = {
  supported: true,
  state: "ready",
  modelId: "native-streaming",
  model: "Native streaming",
  size: 1,
  supportsStreaming: true,
  supportsBufferedStreaming: true,
  supportsTranslation: true,
  languages: ["en", "fr"],
  supportsLanguageDetection: false,
  acceleration: "cpu",
  modelUnloadTimeout: "never",
  gpuDevices: [],
  benchmarkTier: "cpu",
} satisfies EnvironmentSpeechStatus;

it("retains all PCM until stop, retries batch audio, and captures preferences before status resolves", async () => {
  using microphone = capture();
  let streaming = false;
  let options = { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, speechLanguage: "fr" };
  const requests: Array<{ pcm: Uint8Array; options: typeof options }> = [];
  let resolveStatus!: (response: Response) => void;
  const pendingStatus = new Promise<Response>((resolve) => {
    resolveStatus = resolve;
  });
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === `${prepared.httpBaseUrl}/api/voice/status`)
      return (await pendingStatus).clone();
    if (request.url === `${prepared.httpBaseUrl}/api/voice/transcribe`) {
      expect(request.headers.get("authorization")).toBe("Bearer audio-grant");
      requests.push(decodeSpeechPcmRequest(new Uint8Array(await request.arrayBuffer())));
      return requests.length === 1
        ? new Response(null, { status: 503 })
        : Response.json({ text: "bonjour" });
    }
    return fetch(input, init);
  });
  const onError = vi.fn();
  const platform = createBrowserVoiceInputPlatform({
    prepared,
    hasAudioConsent: () => true,
    getStreamingEnabled: () => streaming,
    getTranscriptionOptions: () => options,
    getMicrophoneId: () => "",
    onLevel() {},
    onDurationLimit() {},
    onText() {},
    onError,
  });
  const commitDraft = vi.fn();
  const controller = new VoiceInputController({
    recorder: platform.recorder,
    retryFailedRecording: true,
    getTranscriber: () => platform.transcriber,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: async () => platform.cancelRecording(),
    deleteRecording: platform.deleteRecording,
    readDraft: () => ({
      ownerKey: "draft",
      text: "",
      selection: { start: 0, end: 0 },
      revision: 0,
    }),
    commitDraft,
    onStateChange() {},
  });
  using _controller = { [Symbol.dispose]: () => controller.dispose() };
  const start = controller.start();
  await vi.waitFor(() => expect(_network).toHaveBeenCalled());
  streaming = true;
  options = { ...options, speechLanguage: "en" };
  await start;
  expect(controller.currentState.phase).toBe("recording");
  microphone.feed(new Float32Array([0.1, 0.2]));
  microphone.feed(new Float32Array([0.3]));
  expect(requests).toHaveLength(0);
  const stop = controller.stop();
  await vi.waitFor(() => expect(microphone.stopTrack).toHaveBeenCalledOnce());
  resolveStatus(Response.json(status));
  await stop;
  expect(controller.currentState.phase).toBe("error");
  expect(platform.recorder.uri).not.toBeNull();
  await controller.start();
  expect(controller.currentState.phase).toBe("idle");
  expect(commitDraft).toHaveBeenCalledWith("bonjour", { start: 7, end: 7 });
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect([...new Float32Array(request.pcm.slice().buffer)]).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
    expect(request.options.speechLanguage).toBe("fr");
  }
  expect(platform.recorder.uri).toBeNull();
  expect(microphone.stopTrack).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  streaming = false;
  await controller.start();
  microphone.feed(new Float32Array([0.4]));
  controller.cancel();
  await vi.waitFor(() => expect(microphone.stopTrack).toHaveBeenCalledTimes(2));
  expect(requests).toHaveLength(2);
  expect(platform.recorder.uri).toBeNull();
});

it.each([
  ["fr", ["en-US"], "fr"],
  ["auto", ["nl-NL", "en-US"], "en-US"],
] as const)(
  "resolves Apple Speech language %s with Mac preferences %j",
  (preference, system, expected) => {
    expect(resolveAppleSpeechLocale(["en-US", "fr-FR"], preference, system)).toBe(expected);
  },
);

it.each(["prepare", "transcribe"] as const)(
  "cancels Apple Speech while native %s is pending",
  async (stage) => {
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{ ok: true; value: string }>();
    using _bridge = stubGlobal("desktopBridge", {
      appleSpeech: {
        prepare: async () => {
          if (stage !== "prepare") return { ok: true, value: "en-US" };
          entered.resolve();
          return pending.promise;
        },
        transcribe: async () => {
          entered.resolve();
          return pending.promise;
        },
      },
    });
    const platform = createAppleSpeechVoiceInputPlatform({
      hasAudioConsent: () => true,
      getTranscriptionOptions: () => DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      getMicrophoneId: () => "",
      onLevel() {},
      onDurationLimit() {},
      onError() {},
    });
    const abort = new AbortController();
    using _cleanup = {
      [Symbol.dispose]: () => {
        abort.abort();
        pending.resolve({ ok: true, value: "late" });
        platform.cancelRecording();
      },
    };
    const options = { signal: abort.signal };
    const transcription = await platform.transcriber.prepare(options);
    const uri = URL.createObjectURL(new Blob([new Float32Array([0.5])]));
    using _blob = { [Symbol.dispose]: () => URL.revokeObjectURL(uri) };
    const result = transcription.transcribe(uri, options);
    await entered.promise;
    abort.abort();
    await expect(result).rejects.toThrow();
  },
);

it("streams the opening audio in order when the destination becomes ready during capture", async () => {
  using microphone = capture();
  const feed = vi.fn();
  const finish = vi.fn(async () => "hello");
  const ready = Promise.withResolvers<void>();
  const platform = createBrowserPcmCapture(
    {
      getMicrophoneId: () => "",
      onLevel() {},
      onDurationLimit() {},
      onError() {},
    },
    async () => {
      await ready.promise;
      return {
        locale: "en",
        streaming: { feed, finish, frameSamples: 2_400 },
        transcribe: async () => "",
      };
    },
  );
  const abort = new AbortController();
  using _abort = {
    [Symbol.dispose]: () => {
      abort.abort();
      platform.cancelRecording();
    },
  };
  const transcription = await platform.transcriber.prepare({ signal: abort.signal });
  await platform.recorder.prepareToRecordAsync(abort.signal);
  platform.recorder.record({ forDuration: 1 });
  const opening = new Float32Array([0.1]);
  const continuing = new Float32Array([0.2]);
  microphone.feed(opening);
  expect(feed).not.toHaveBeenCalled();
  ready.resolve();
  await vi.waitFor(() => expect(feed).toHaveBeenCalledExactlyOnceWith(opening));
  expect(microphone.workletMessages).toContainEqual({ frameSamples: 2_400 });
  microphone.feed(continuing);
  await platform.recorder.stop();
  expect(feed.mock.calls).toEqual([[opening], [continuing]]);
  expect(platform.recorder.uri).toBeNull();
  await expect(transcription.streaming?.finish({ signal: abort.signal })).resolves.toBe("hello");
});

it.each([
  { native: true, enabled: true, buffered: true, live: true },
  { native: true, enabled: false, buffered: true, live: false },
  { native: false, enabled: false, buffered: true, live: true },
  { native: false, enabled: true, buffered: true, live: true },
  { native: false, enabled: false, buffered: false, live: false },
])(
  "selects the destination model's processing path: %j",
  async ({ native, enabled, buffered, live }) => {
    const sockets: string[] = [];
    using _socket = stubGlobal(
      "WebSocket",
      class extends EventTarget {
        constructor(url: string) {
          super();
          sockets.push(url);
        }
        close() {}
      },
    );
    using _network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/api/voice/status"))
        return Response.json({
          ...status,
          supportsStreaming: native,
          supportsBufferedStreaming: buffered,
        });
      if (request.url.includes("/api/auth/websocket-ticket/"))
        return Response.json({ ticket: "stream-ticket", expiresAt: "2030-01-01T00:00:00.000Z" });
      throw new Error(`Unexpected request: ${request.url}`);
    });
    const abort = new AbortController();
    using _abort = { [Symbol.dispose]: () => abort.abort() };
    const platform = createBrowserVoiceInputPlatform({
      prepared,
      hasAudioConsent: () => true,
      getStreamingEnabled: () => enabled,
      getTranscriptionOptions: () => ({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechTranslateToEnglish: true,
        speechLanguage: "fr",
      }),
      getMicrophoneId: () => "",
      onLevel() {},
      onDurationLimit() {},
      onText() {},
      onError() {},
    });
    const transcription = await platform.transcriber.prepare({ signal: abort.signal });
    await vi.waitFor(() => expect(transcription.locale).toBe(native && enabled ? "fr" : "en"));
    expect(Boolean(transcription.streaming)).toBe(live);
    expect(sockets).toEqual(
      live ? ["wss://transcription.example.test/ws/voice?wsTicket=stream-ticket"] : [],
    );
  },
);

it.each([
  { provider: "whisper", streamingUrl: true, live: true },
  { provider: "whisper", streamingUrl: false, live: false },
  { provider: "openai", streamingUrl: true, live: false },
] as const)(
  "streams cloud audio only for a Whisper grant, on its own socket: %j",
  async ({ provider, streamingUrl, live }) => {
    using microphone = capture();
    const sockets: string[] = [];
    using _socket = stubGlobal(
      "WebSocket",
      class extends EventTarget {
        constructor(url: string) {
          super();
          sockets.push(url);
        }
        close() {}
      },
    );
    using _network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/api/voice/cloud/keys"))
        return Response.json({
          openai: true,
          xai: false,
          openrouter: false,
          whisper: true,
          whisperStreaming: streamingUrl,
        });
      if (request.url.includes("/api/auth/websocket-ticket/"))
        return Response.json({ ticket: "stream-ticket", expiresAt: "2030-01-01T00:00:00.000Z" });
      throw new Error(`Unexpected request: ${request.url}`);
    });
    const abort = new AbortController();
    using _abort = { [Symbol.dispose]: () => abort.abort() };
    const platform = createBrowserVoiceInputPlatform({
      prepared,
      cloudProvider: provider,
      hasAudioConsent: () => true,
      // The local models' streaming preference does not apply to cloud streaming.
      getStreamingEnabled: () => false,
      getTranscriptionOptions: () => ({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "fr",
      }),
      getMicrophoneId: () => "",
      onLevel() {},
      onDurationLimit() {},
      onText() {},
      onError() {},
    });
    using _capture = { [Symbol.dispose]: () => platform.cancelRecording() };
    const transcription = await platform.transcriber.prepare({ signal: abort.signal });
    await vi.waitFor(() => expect(transcription.locale).toBe("fr"));
    expect(Boolean(transcription.streaming)).toBe(live);
    await platform.recorder.prepareToRecordAsync(abort.signal);
    // Small frames let a live cloud recognizer hear each word promptly.
    expect(microphone.workletOptions.at(-1)?.processorOptions?.frameSamples).toBe(
      live ? 2_400 : undefined,
    );
    expect(sockets).toEqual(
      live
        ? ["wss://transcription.example.test/ws/voice/cloud/whisper?wsTicket=stream-ticket"]
        : [],
    );
  },
);
