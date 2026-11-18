import type { PreparedVoiceTranscription } from "@t3tools/client-runtime/voice-input";
import { expect, it, vi } from "vite-plus/test";

import type { LazyVoiceRecorder } from "./lazyVoiceRecorder";
import {
  createPcmStreamCapture,
  type CaptureStatus,
  type NativePcmBuffer,
} from "./pcmStreamCapture";

function setup() {
  const fileRecorder = {
    uri: "file:///voice.m4a",
    prepareToRecordAsync: vi.fn(async () => {}),
    record: vi.fn(),
    stop: vi.fn(async () => {}),
    getStatus: vi.fn((): CaptureStatus | null => null),
    release: vi.fn(),
  } satisfies LazyVoiceRecorder<CaptureStatus>;
  let emit: (buffer: NativePcmBuffer) => void = () => {};
  const stream = {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    release: vi.fn(),
    addListener: vi.fn((_event: "audioStreamBuffer", listener: (b: NativePcmBuffer) => void) => {
      emit = listener;
      return { remove: vi.fn() };
    }),
  };
  const onDurationLimit = vi.fn();
  const onError = vi.fn();
  const capture = createPcmStreamCapture({
    fileRecorder,
    createStream: () => stream,
    onDurationLimit,
    onError,
  });
  const prepare = (prepared: PreparedVoiceTranscription) =>
    capture.transcriber({ prepare: async () => prepared }).prepare({
      signal: new AbortController().signal,
    });
  const buffer = (samples: number[], sampleRate = 16_000): NativePcmBuffer => ({
    data: new Float32Array(samples).buffer,
    sampleRate,
    channels: 1,
  });
  return {
    capture,
    fileRecorder,
    stream,
    onDurationLimit,
    onError,
    prepare,
    buffer,
    emit: (b: NativePcmBuffer) => emit(b),
  };
}

it("records to a file unless the transcription streams, then feeds PCM only while recording", async () => {
  const { capture, fileRecorder, stream, prepare, buffer, emit } = setup();
  await prepare({ locale: "en", transcribe: async () => "" });
  await capture.recorder.prepareToRecordAsync();
  expect(fileRecorder.prepareToRecordAsync).toHaveBeenCalledOnce();
  expect(stream.start).not.toHaveBeenCalled();
  expect(capture.recorder.uri).toBe("file:///voice.m4a");

  const feed = vi.fn();
  await prepare({ locale: "en", transcribe: async () => "", streaming: { feed, finish: vi.fn() } });
  await capture.recorder.prepareToRecordAsync();
  expect(stream.start).toHaveBeenCalledOnce();
  expect(capture.recorder.uri).toBeNull();
  emit(buffer([0.5]));
  expect(feed).not.toHaveBeenCalled();
  capture.recorder.record({ forDuration: 300 });
  emit(buffer([0.5, -0.25]));
  expect(Array.from(feed.mock.lastCall![0] as Float32Array)).toEqual([0.5, -0.25]);
  expect(capture.recorder.getStatus()).toMatchObject({ isRecording: true });

  await capture.recorder.stop();
  expect(stream.stop).toHaveBeenCalledOnce();
  expect(stream.release).toHaveBeenCalledOnce();
  expect(fileRecorder.stop).not.toHaveBeenCalled();
});

it("stops at the recording limit and fails on audio it cannot stream", async () => {
  const { capture, stream, onDurationLimit, onError, prepare, buffer, emit } = setup();
  const feed = vi.fn();
  await prepare({ locale: "en", transcribe: async () => "", streaming: { feed, finish: vi.fn() } });
  await capture.recorder.prepareToRecordAsync();
  capture.recorder.record({ forDuration: 2 / 16_000 });
  emit(buffer([0.1, 0.1]));
  expect(onDurationLimit).toHaveBeenCalledOnce();
  emit(buffer([0.1]));
  expect(feed).toHaveBeenCalledOnce();

  await capture.recorder.prepareToRecordAsync();
  capture.recorder.record({ forDuration: 300 });
  emit(buffer([0.1], 48_000));
  expect(onError).toHaveBeenCalledWith(
    "This microphone can’t stream audio for live transcription.",
  );
  expect(stream.release).toHaveBeenCalledTimes(2);
  expect(feed).toHaveBeenCalledOnce();
});
