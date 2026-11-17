import { cloudSpeechLanguages, effectiveSpeechLanguage } from "@t3tools/shared/speech";
import {
  requireCloudSpeechKey,
  transcribeCloudPcm,
  getCloudWhisperSpeechStreamUrl,
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechStreamUrl,
  openSpeechStream,
  throwIfVoiceTranscriptionAborted,
  transcribeEnvironmentPcm,
  type VoiceInputErrorCode,
  VoiceTranscriptionError,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { SpeechTranscriptionOptions, SpeechStreamText } from "@t3tools/contracts";
import type { CloudSpeechModelId, CloudSpeechProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { createBrowserPcmCapture } from "./browserPcmCapture";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import { msg } from "gt-react";
import { m } from "../i18n/messages";

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);
// 150 ms: the cloud recognizer revises its live text about 0.7 s after each word.
const CLOUD_STREAM_FRAME_SAMPLES = 2_400;

export function createBrowserVoiceInputPlatform(input: {
  readonly prepared: PreparedConnection;
  readonly cloudProvider?: CloudSpeechProvider | undefined;
  /** The exact OpenRouter model the grant names; required with that provider. */
  readonly cloudModel?: CloudSpeechModelId | undefined;
  readonly hasAudioConsent: () => boolean;
  readonly getTranscriptionOptions: () => SpeechTranscriptionOptions;
  readonly getStreamingEnabled: () => boolean;
  readonly getMicrophoneId: () => string | Promise<string>;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit: () => void;
  readonly onText: (text: SpeechStreamText) => void;
  readonly onError: (message: string, code?: VoiceInputErrorCode) => void;
}) {
  return createBrowserPcmCapture(input, async (options) => {
    const recordingOptions = input.getTranscriptionOptions();
    const streamingEnabled = input.getStreamingEnabled();
    const transcribeRecording = async (
      uri: string,
      { signal: transcriptionSignal }: VoiceTranscriptionOptions,
    ) => {
      try {
        const response = await fetch(uri, { signal: transcriptionSignal });
        const pcm = new Uint8Array(await response.arrayBuffer());
        const result = await runEnvironmentSpeech(
          input.cloudProvider
            ? transcribeCloudPcm(
                input.prepared,
                input.cloudProvider,
                pcm,
                recordingOptions,
                input.hasAudioConsent,
                input.cloudModel,
              )
            : transcribeEnvironmentPcm(
                input.prepared,
                pcm,
                recordingOptions,
                input.hasAudioConsent,
              ),
          { signal: transcriptionSignal },
        );
        throwIfVoiceTranscriptionAborted(transcriptionSignal);
        return result.text;
      } catch (cause) {
        throwIfVoiceTranscriptionAborted(transcriptionSignal);
        if (isVoiceTranscriptionError(cause)) throw cause;
        throw new VoiceTranscriptionError({
          code: "transcription-failed",
          message: m(msg("Voice transcription failed. Check the destination in Settings → Voice.")),
          cause,
        });
      }
    };
    if (input.cloudProvider) {
      if (input.cloudProvider === "openrouter" && !input.cloudModel)
        throw new VoiceTranscriptionError({
          code: "unavailable",
          message: m(msg("Choose an OpenRouter model in Settings → Voice.")),
        });
      const keys = await runEnvironmentSpeech(
        requireCloudSpeechKey(input.prepared, input.cloudProvider),
        options,
      );
      throwIfVoiceTranscriptionAborted(options.signal);
      const locale = effectiveSpeechLanguage(cloudSpeechLanguages, recordingOptions.speechLanguage);
      if (input.cloudProvider !== "whisper" || !keys.whisperStreaming)
        return { locale, transcribe: transcribeRecording };
      // A failed stream reports its error; it never falls back to batch or another provider.
      const url = await runEnvironmentSpeech(
        getCloudWhisperSpeechStreamUrl(input.prepared),
        options,
      );
      return {
        locale,
        transcribe: transcribeRecording,
        streaming: {
          ...openSpeechStream({
            url,
            canSend: input.hasAudioConsent,
            options: recordingOptions,
            signal: options.signal,
            onText: input.onText,
            onError: (error) => input.onError(error.message),
          }),
          frameSamples: CLOUD_STREAM_FRAME_SAMPLES,
        },
      };
    }
    const status = await runEnvironmentSpeech(getEnvironmentSpeechStatus(input.prepared), options);
    throwIfVoiceTranscriptionAborted(options.signal);
    if (!status.supported)
      throw new VoiceTranscriptionError({ code: "unavailable", message: status.reason });
    const language = status.languages
      ? effectiveSpeechLanguage(
          {
            languages: status.languages,
            supportsLanguageDetection: status.supportsLanguageDetection ?? false,
          },
          recordingOptions.speechLanguage,
        )
      : "auto";
    const nativeStreaming = status.supportsStreaming && streamingEnabled;
    const locale =
      !nativeStreaming && status.supportsTranslation && recordingOptions.speechTranslateToEnglish
        ? "en"
        : language;
    if (status.supportsStreaming ? !nativeStreaming : !status.supportsBufferedStreaming) {
      return { locale, transcribe: transcribeRecording };
    }
    const url = await runEnvironmentSpeech(getEnvironmentSpeechStreamUrl(input.prepared), options);
    return {
      locale,
      transcribe: transcribeRecording,
      streaming: openSpeechStream({
        url,
        canSend: input.hasAudioConsent,
        options: recordingOptions,
        signal: options.signal,
        onText: input.onText,
        onError: (error) => input.onError(error.message),
      }),
    };
  });
}
