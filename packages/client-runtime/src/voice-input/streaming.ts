import type { CloudSpeechProvider } from "@t3tools/contracts";

/** Only the Whisper-compatible endpoint has a realtime socket; other providers take the recording. */
export function streamsCloudSpeech(
  provider: CloudSpeechProvider,
  keys: { readonly whisperStreaming?: boolean },
): boolean {
  return provider === "whisper" && keys.whisperStreaming === true;
}

/** A natively streaming model honours the streaming setting; a buffered one always streams. */
export function streamsEnvironmentSpeech(
  status: { readonly supportsStreaming: boolean; readonly supportsBufferedStreaming?: boolean },
  streamingEnabled: boolean,
): boolean {
  return status.supportsStreaming ? streamingEnabled : status.supportsBufferedStreaming === true;
}
