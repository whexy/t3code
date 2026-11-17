import type { CloudSpeechWhisperEndpoint, SpeechTranscriptionOptions } from "@t3tools/contracts";
import { HttpClientRequest } from "effect/http";

/**
 * An OpenAI Whisper-compatible `POST /v1/audio/transcriptions` request. Whisper takes vocabulary
 * only as a free-text `prompt`, so dictionary terms travel as a comma-separated list.
 */
export function whisperSpeechRequest(
  endpoint: CloudSpeechWhisperEndpoint,
  audio: ArrayBuffer,
  language: string,
  options: SpeechTranscriptionOptions,
) {
  const form = new FormData();
  form.set("model", endpoint.model);
  form.set("response_format", "json");
  if (language !== "auto") form.set("language", language);
  const terms = options.speechCustomWords.map(({ term }) => term);
  if (terms.length > 0) form.set("prompt", terms.join(", "));
  form.set("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
  return HttpClientRequest.post(endpoint.url).pipe(HttpClientRequest.bodyFormData(form));
}
