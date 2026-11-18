import {
  AuthOrchestrationOperateScope,
  type CloudSpeechModelId,
  type CloudSpeechProvider,
  type EnvironmentId,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  type SpeechPostProcessingOptions,
  type SpeechStreamText,
  type VoiceTranscriptionDestination,
} from "@t3tools/contracts";
import {
  getEnvironmentSpeechModels,
  getCloudSpeechKeys,
  getCloudSpeechModels,
  requireCloudSpeechKey,
  transcribeCloudPcm,
  getCloudWhisperSpeechStreamUrl,
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechStreamUrl,
  openSpeechStream,
  postProcessEnvironmentTranscript,
  streamsCloudSpeech,
  streamsEnvironmentSpeech,
  transcribeEnvironmentPcm,
  transcriptCleanupContext,
  VoiceTranscriptionError,
  type VoiceDraftSnapshot,
  type VoiceStreamingSession,
} from "@t3tools/client-runtime/voice-input";
import { FetchHttpClient, type HttpClient } from "effect/http";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { effectiveSpeechLanguage } from "@t3tools/shared/speech";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";
import { fetch as expoFetch } from "expo/fetch";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession, sessionHasScope } from "../../state/session";
import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";
import { createEnvironmentTranscriber } from "./environmentTranscriber";
import { readVoiceGrant, writeVoiceGrant, type VoiceGrant } from "./voiceGrantStorage";

const storedGrant = Atom.make(Effect.promise(readVoiceGrant)).pipe(Atom.keepAlive);
const choice = Atom.make<VoiceGrant | null | undefined>(undefined).pipe(Atom.keepAlive);
export const voiceGrantAtom = Atom.make((get) => {
  const chosen = get(choice);
  if (chosen !== undefined) return chosen;
  return AsyncResult.getOrElse(get(storedGrant), () => null);
});

let choiceRevision = 0;

type CloudDestination = Extract<VoiceTranscriptionDestination, { kind: "cloud" }>;
/** OpenRouter has no default model, so a cloud choice without one is no choice at all. */
function cloudVoiceDestination(
  environmentId: EnvironmentId,
  provider: CloudSpeechProvider,
  model?: CloudSpeechModelId,
): CloudDestination | null {
  if (provider === "openrouter")
    return model ? { kind: "cloud", environmentId, provider, model } : null;
  return { kind: "cloud", environmentId, provider };
}

export function chooseVoiceDestination(
  environmentId: EnvironmentId | null,
  provider?: CloudSpeechProvider,
  model?: CloudSpeechModelId,
) {
  choiceRevision++;
  // A failed change must not leave the old destination armed in this session.
  appAtomRegistry.set(choice, null);
  const destination: VoiceTranscriptionDestination | null =
    environmentId === null
      ? null
      : provider
        ? cloudVoiceDestination(environmentId, provider, model)
        : { kind: "environment", environmentId };
  const grant: VoiceGrant | null = destination && { id: uuidv4(), destination };
  writeVoiceGrant(grant);
  appAtomRegistry.set(choice, grant);
}

export function pendingCloudVoiceChoice(
  id: EnvironmentId,
  provider: CloudSpeechProvider,
  model?: CloudSpeechModelId,
) {
  const revision = ++choiceRevision;
  return () => {
    if (revision === choiceRevision) chooseVoiceDestination(id, provider, model);
  };
}

const native = requireOptionalNativeModule<{
  decodeRecording?: (uri: string) => Promise<Uint8Array>;
}>("T3VoiceTranscription");
export const hasEnvironmentVoiceCapture = typeof native?.decodeRecording === "function";

const voiceConnections = (capability: "voiceTranscription" | "cloudVoiceTranscription") =>
  Atom.family((id: EnvironmentId) =>
    Atom.make((get) => {
      const environment = get(environmentPresentations.presentationAtom(id));
      if (
        !hasEnvironmentVoiceCapture ||
        environment?.connection.phase !== "connected" ||
        !environment.serverConfig?.environment.capabilities[capability] ||
        !sessionHasScope(
          get(environmentSession.sessionStateAtom(id)),
          AuthOrchestrationOperateScope,
        )
      )
        return null;
      return Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(id)));
    }),
  );
export const voiceConnectionAtom = voiceConnections("voiceTranscription");
export const cloudVoiceConnectionAtom = voiceConnections("cloudVoiceTranscription");

/** Cleanup runs on the draft's own environment, never on the audio destination. */
const cleanupConnectionAtom = Atom.family((id: EnvironmentId) =>
  Atom.make((get) => {
    const environment = get(environmentPresentations.presentationAtom(id));
    const capabilities = environment?.serverConfig?.environment.capabilities;
    if (
      environment?.connection.phase !== "connected" ||
      !(capabilities?.voiceTranscription || capabilities?.cloudVoiceTranscription) ||
      !sessionHasScope(get(environmentSession.sessionStateAtom(id)), AuthOrchestrationOperateScope)
    )
      return null;
    return Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(id)));
  }),
);

// The phone has no instructions, cue or dictionary settings, so cleanup uses web's defaults.
const CLEANUP_OPTIONS: SpeechPostProcessingOptions = {
  speechCustomWords: [],
  speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
};

export function cleanUpVoiceTranscript(
  environmentId: EnvironmentId,
  transcript: string,
  draft: VoiceDraftSnapshot,
  signal: AbortSignal,
  canSend: () => boolean,
) {
  const prepared = appAtomRegistry.get(cleanupConnectionAtom(environmentId));
  if (!prepared)
    return Promise.reject(
      new Error("The draft's environment is unavailable for transcript cleanup."),
    );
  return runSpeech(
    postProcessEnvironmentTranscript(
      prepared,
      transcript,
      transcriptCleanupContext(draft),
      CLEANUP_OPTIONS,
      canSend,
    ),
    signal,
    canSend,
  ).then((result) => result.text);
}

// React Native's XMLHttpRequest fetch follows redirects. Expo's native transport honors redirect: "error".
export function runSpeech<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  signal?: AbortSignal,
  canSend: () => boolean = () => true,
) {
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        effect.pipe(
          Effect.provideService(FetchHttpClient.Fetch, async (url, options) => {
            if (signal?.aborted || !canSend())
              throw new VoiceTranscriptionError({
                code: "cancelled",
                message: "Your transcription choice changed.",
              });
            return expoFetch(url, { ...options, redirect: "error" });
          }),
          Effect.provide(context),
        ),
      ),
    ),
    { signal },
  );
}
type VoiceStreamListeners = {
  readonly streamingEnabled: () => boolean;
  readonly onText: (text: SpeechStreamText) => void;
  readonly onError: (message: string) => void;
};

let streamListeners: VoiceStreamListeners = {
  streamingEnabled: () => true,
  onText: () => {},
  onError: () => {},
};

/** The app has one dictation at a time; its session receives every live stream's text and failure. */
export function listenToVoiceStreams(listeners: VoiceStreamListeners) {
  streamListeners = listeners;
}

function environmentTranscriber(
  prepared: PreparedConnection,
  canSend: () => boolean,
  cloud?: CloudDestination,
) {
  const provider = cloud?.provider;
  const model = cloud?.provider === "openrouter" ? cloud.model : undefined;
  // A failed stream reports its error; it never falls back to batch or another provider.
  const openStream = async <E>(
    url: Effect.Effect<string, E, HttpClient.HttpClient>,
    signal: AbortSignal,
  ): Promise<VoiceStreamingSession> => {
    const listeners = streamListeners;
    return openSpeechStream({
      url: await runSpeech(url, signal, canSend),
      options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      signal,
      canSend,
      onText: listeners.onText,
      onError: (error) => listeners.onError(error.message),
    });
  };
  return createEnvironmentTranscriber({
    canSend,
    prepare: async (signal) => {
      if (provider) {
        const keys = await runSpeech(requireCloudSpeechKey(prepared, provider), signal, canSend);
        if (!streamsCloudSpeech(provider, keys)) return { locale: "auto" };
        return {
          locale: "auto",
          streaming: await openStream(getCloudWhisperSpeechStreamUrl(prepared), signal),
        };
      }
      const status = await runSpeech(getEnvironmentSpeechStatus(prepared), signal, canSend);
      if (!status.supported)
        throw new VoiceTranscriptionError({ code: "unavailable", message: status.reason });
      if (status.state === "missing-model")
        throw new VoiceTranscriptionError({
          code: "unavailable",
          message:
            "Install a transcription model for this environment in Settings → Voice, then try again.",
        });
      const locale = status.languages
        ? effectiveSpeechLanguage(
            {
              languages: status.languages,
              supportsLanguageDetection: status.supportsLanguageDetection ?? false,
            },
            "auto",
          )
        : "auto";
      if (!streamsEnvironmentSpeech(status, streamListeners.streamingEnabled())) return { locale };
      return {
        locale,
        streaming: await openStream(getEnvironmentSpeechStreamUrl(prepared), signal),
      };
    },
    decode: (uri) => {
      if (!native?.decodeRecording)
        throw new VoiceTranscriptionError({
          code: "unavailable",
          message: "Update T3 Code to transcribe on an environment.",
        });
      return native.decodeRecording(uri);
    },
    upload: async (pcm, signal) =>
      (
        await runSpeech(
          provider
            ? transcribeCloudPcm(
                prepared,
                provider,
                pcm,
                DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
                canSend,
                model,
              )
            : transcribeEnvironmentPcm(
                prepared,
                pcm,
                DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
                canSend,
              ),
          signal,
          canSend,
        )
      ).text,
  });
}

const speechAtom = <A, E>(
  id: EnvironmentId,
  read: (prepared: PreparedConnection) => Effect.Effect<A, E, HttpClient.HttpClient>,
  connectionAtom = voiceConnectionAtom,
) =>
  Atom.make((get) => {
    const prepared = get(connectionAtom(id));
    return prepared
      ? Effect.tryPromise({
          try: (signal) => runSpeech(read(prepared), signal),
          catch: (cause) =>
            new VoiceTranscriptionError({
              code: "unavailable",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        })
      : Effect.succeed(null);
  });

export const voiceSpeechStatusAtom = Atom.family((id: EnvironmentId) =>
  speechAtom(id, getEnvironmentSpeechStatus),
);
export const cloudVoiceKeysAtom = Atom.family((id: EnvironmentId) =>
  speechAtom(id, getCloudSpeechKeys, cloudVoiceConnectionAtom),
);
export const cloudVoiceModelsAtom = Atom.family((id: EnvironmentId | null) =>
  id === null
    ? Atom.make(Effect.succeed(null))
    : speechAtom(id, getCloudSpeechModels, cloudVoiceConnectionAtom),
);
export const voiceSpeechModelsAtom = Atom.family((id: EnvironmentId) =>
  speechAtom(id, (prepared) => getEnvironmentSpeechModels(prepared)),
);
// Fetched once for the model sheet; download progress polls the lighter list above.
export const voiceSpeechBenchmarksAtom = Atom.family((id: EnvironmentId) =>
  speechAtom(id, (prepared) => getEnvironmentSpeechModels(prepared, true)),
);

// null selects on-device; a grant with no usable transcriber must never fall back.
export const voiceRouteAtom = Atom.make((get) => {
  const grant = get(voiceGrantAtom);
  if (!grant) return null;
  const cloud = grant.destination.kind === "cloud" ? grant.destination : undefined;
  const connectionAtom = (cloud ? cloudVoiceConnectionAtom : voiceConnectionAtom)(
    grant.destination.environmentId,
  );
  const connection = get(connectionAtom);
  const registry = get.registry;
  return {
    transcriber:
      connection &&
      environmentTranscriber(
        connection,
        () => registry.get(voiceGrantAtom) === grant && registry.get(connectionAtom) === connection,
        cloud,
      ),
  };
});
