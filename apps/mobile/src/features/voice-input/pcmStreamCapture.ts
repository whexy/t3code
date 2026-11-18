import {
  throwIfVoiceTranscriptionAborted,
  type VoiceRecorder,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import type { LazyVoiceRecorder } from "./lazyVoiceRecorder";

const SAMPLE_RATE = 16_000;

export type NativePcmBuffer = {
  readonly data: ArrayBuffer;
  readonly sampleRate: number;
  readonly channels: number;
};

/** Expo Audio's AudioStream, created for 16 kHz mono float32. */
export interface NativePcmStream {
  start(): Promise<void>;
  stop(): void;
  addListener(
    eventName: "audioStreamBuffer",
    listener: (buffer: NativePcmBuffer) => void,
  ): { remove(): void };
  release(): void;
}

export type CaptureStatus = {
  readonly isRecording: boolean;
  readonly durationMillis: number;
  readonly metering?: number | undefined;
};

/**
 * Records to a file, unless the prepared transcription streams: then microphone PCM goes to the
 * live session and nothing is written. The stream ignores the preferred-microphone order.
 */
export function createPcmStreamCapture<TState extends CaptureStatus>(input: {
  readonly fileRecorder: LazyVoiceRecorder<TState>;
  readonly createStream: () => NativePcmStream;
  readonly onDurationLimit: () => void;
  readonly onError: (message: string) => void;
}) {
  let feed: ((pcm: Float32Array) => void) | undefined;
  let stream: NativePcmStream | null = null;
  let subscription: { remove(): void } | null = null;
  let capturing = false;
  let samples = 0;
  let limit = Number.POSITIVE_INFINITY;
  let metering: number | undefined;

  const releaseStream = () => {
    capturing = false;
    subscription?.remove();
    subscription = null;
    const released = stream;
    stream = null;
    if (!released) return;
    try {
      released.stop();
    } finally {
      released.release();
    }
  };

  const fail = (message: string) => {
    releaseStream();
    input.onError(message);
  };

  const recorder: VoiceRecorder & {
    getStatus(): CaptureStatus | null;
    release(): void;
  } = {
    get uri() {
      return feed ? null : input.fileRecorder.uri;
    },
    async prepareToRecordAsync(signal) {
      releaseStream();
      const live = feed;
      if (!live) return input.fileRecorder.prepareToRecordAsync(signal);
      samples = 0;
      metering = undefined;
      limit = Number.POSITIVE_INFINITY;
      const next = input.createStream();
      stream = next;
      subscription = next.addListener("audioStreamBuffer", (buffer) => {
        if (stream !== next || !capturing) return;
        if (buffer.sampleRate !== SAMPLE_RATE || buffer.channels !== 1) {
          fail("This microphone can’t stream audio for live transcription.");
          return;
        }
        const pcm = new Float32Array(buffer.data);
        let peak = 0;
        for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
        metering = peak > 0 ? 20 * Math.log10(peak) : -160;
        samples += pcm.length;
        live(pcm);
        if (samples >= limit) {
          capturing = false;
          input.onDurationLimit();
        }
      });
      try {
        await next.start();
        if (signal) throwIfVoiceTranscriptionAborted(signal);
      } catch (error) {
        if (stream === next) releaseStream();
        throw error;
      }
    },
    record(options) {
      if (!feed) return input.fileRecorder.record(options);
      if (!stream) throw new Error("The voice recorder isn’t ready. Try again.");
      limit = options.forDuration * SAMPLE_RATE;
      capturing = true;
    },
    async stop() {
      if (stream) releaseStream();
      else await input.fileRecorder.stop();
    },
    getStatus() {
      if (!stream) return input.fileRecorder.getStatus();
      return { isRecording: capturing, durationMillis: (samples / SAMPLE_RATE) * 1_000, metering };
    },
    release() {
      releaseStream();
      input.fileRecorder.release();
    },
  };

  return {
    recorder,
    /** Every transcription goes through here so the recorder knows whether it streams. */
    transcriber: (transcriber: VoiceTranscriber): VoiceTranscriber => ({
      prepare: async (options) => {
        feed = undefined;
        const prepared = await transcriber.prepare(options);
        feed = prepared.streaming?.feed;
        return prepared;
      },
    }),
  };
}
