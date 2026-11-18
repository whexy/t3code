import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputPhase,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId } from "@t3tools/contracts";

import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const VOICE_METERING_INTERVAL_MS = 80;
const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const SILENT_LEVELS: ReadonlyArray<number> = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);

export type VoiceInputTarget = {
  readonly ownerKey: string;
  /** The draft's environment, where transcript cleanup runs. */
  readonly environmentId: EnvironmentId | null;
  readonly label?: string;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: VoiceInputControllerDependencies["commitDraft"];
};

export type VoiceInputSnapshot = {
  readonly state: VoiceInputState;
  readonly ownerKey: string | null;
  readonly label: string | null;
  readonly elapsedSeconds: number;
  readonly focusedOwners: ReadonlySet<string>;
};

export type VoiceRecordingSample = {
  readonly durationMillis: number;
  readonly metering: number | undefined;
};

export type VoiceInputSessionDependencies = Omit<
  VoiceInputControllerDependencies,
  "readDraft" | "commitDraft" | "onStateChange" | "postProcess"
> & {
  /** Returns null when cleanup is off for this transcript. */
  readonly cleanUpTranscript?: (
    transcript: string,
    options: {
      readonly signal: AbortSignal;
      readonly draft: VoiceDraftSnapshot;
      readonly environmentId: EnvironmentId;
    },
  ) => Promise<string> | null;
  /** Reads the live recorder, or null when it is not capturing. */
  readonly sampleRecording: () => VoiceRecordingSample | null;
  /** Levels change every metering tick, so they bypass React state. */
  readonly publishAudioLevels: (levels: ReadonlyArray<number>) => void;
  /** Holds the screen awake while recording; returns the release. */
  readonly keepAwake: () => () => void;
};

export function createVoiceInputTarget(
  ownerKey: string,
  readText: () => string | null,
  commitDraft: VoiceInputTarget["commitDraft"],
  selection: VoiceDraftSnapshot["selection"],
  environmentId: EnvironmentId | null = null,
): VoiceInputTarget {
  return {
    ownerKey,
    environmentId,
    readDraft: () => {
      const text = readText();
      return text === null ? null : { ownerKey, text, selection };
    },
    commitDraft,
  };
}

/**
 * The app's single voice input: it owns the controller, the recording-only
 * side effects (keep-awake, metering) and publishes what the UI renders.
 */
export class VoiceInputSession {
  readonly controller: VoiceInputController;
  private readonly dependencies: VoiceInputSessionDependencies;
  private target: VoiceInputTarget | null = null;
  private startText: string | null = null;
  private snapshot: VoiceInputSnapshot = {
    state: IDLE_STATE,
    ownerKey: null,
    label: null,
    elapsedSeconds: 0,
    focusedOwners: new Set(),
  };
  private readonly listeners = new Set<() => void>();
  private audioLevels = SILENT_LEVELS;
  private releaseKeepAwake: (() => void) | null = null;
  private meteringInterval: ReturnType<typeof setInterval> | null = null;

  constructor(dependencies: VoiceInputSessionDependencies) {
    this.dependencies = dependencies;
    this.controller = new VoiceInputController({
      ...dependencies,
      onStateChange: (state) => this.handleStateChange(state),
      // The target's selection is fixed at start, so a draft changed since refuses the transcript.
      readDraft: () => {
        const draft = this.target?.readDraft() ?? null;
        return draft?.text === this.startText ? draft : null;
      },
      commitDraft: (text, selection) => this.target?.commitDraft(text, selection),
      postProcess: (transcript, options) => {
        const environmentId = this.target?.environmentId;
        return environmentId && this.target?.ownerKey === options.draft.ownerKey
          ? (dependencies.cleanUpTranscript?.(transcript, { ...options, environmentId }) ?? null)
          : null;
      },
    });
  }

  get ownerKey(): string | null {
    return this.target?.ownerKey ?? null;
  }

  get label(): string | null {
    return this.target?.label ?? null;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceInputSnapshot => this.snapshot;

  setOwnerFocused(ownerKey: string, focused: boolean): void {
    if (this.snapshot.focusedOwners.has(ownerKey) === focused) return;
    const focusedOwners = new Set(this.snapshot.focusedOwners);
    if (focused) focusedOwners.add(ownerKey);
    else focusedOwners.delete(ownerKey);
    this.publish({ ...this.snapshot, focusedOwners });
  }

  /** Finishes the recording, or keeps the raw transcript while cleanup runs. */
  finish(): Promise<void> {
    if (this.controller.currentState.phase !== "post-processing") return this.controller.stop();
    this.controller.skipPostProcessing();
    return Promise.resolve();
  }

  cancel(ownerKey: string | null): void {
    if (ownerKey !== null && this.ownerKey === ownerKey) this.controller.cancel();
  }

  retry(): Promise<void> {
    return this.target ? this.start(this.target) : Promise.resolve();
  }

  start(target: VoiceInputTarget): Promise<void> {
    if (voiceInputBlocksSubmission(this.controller.currentState)) return Promise.resolve();
    this.target = target;
    this.startText = target.readDraft()?.text ?? null;
    return this.controller.start();
  }

  dispose(): void {
    this.controller.dispose();
    this.stopRecordingActivity();
    this.listeners.clear();
  }

  private handleStateChange(state: VoiceInputState): void {
    const previousPhase = this.snapshot.state.phase;
    let elapsedSeconds = this.snapshot.elapsedSeconds;
    if (state.phase !== previousPhase) {
      if (previousPhase === "recording") this.stopRecordingActivity();
      if (capturesAudio(state.phase)) {
        if (this.audioLevels.some((level) => level !== 0)) this.setAudioLevels(SILENT_LEVELS);
        elapsedSeconds = 0;
      }
    }
    this.publish({
      ...this.snapshot,
      state,
      ownerKey: this.ownerKey,
      label: this.label,
      elapsedSeconds,
    });
    if (state.phase === "recording" && previousPhase !== "recording") {
      this.startRecordingActivity();
    }
  }

  private startRecordingActivity(): void {
    this.releaseKeepAwake = this.dependencies.keepAwake();
    this.sampleRecording();
    this.meteringInterval = setInterval(() => this.sampleRecording(), VOICE_METERING_INTERVAL_MS);
  }

  private stopRecordingActivity(): void {
    if (this.meteringInterval !== null) clearInterval(this.meteringInterval);
    this.meteringInterval = null;
    this.releaseKeepAwake?.();
    this.releaseKeepAwake = null;
  }

  private sampleRecording(): void {
    if (this.controller.currentState.phase !== "recording") return;
    const sample = this.dependencies.sampleRecording();
    if (!sample) return;

    const level = normalizeVoiceInputDecibels(sample.metering);
    if (level !== 0 || this.audioLevels.some((sample) => sample !== 0)) {
      this.setAudioLevels([...this.audioLevels.slice(1), level]);
    }

    const elapsedSeconds = Math.min(
      VOICE_RECORDING_LIMIT_SECONDS,
      Math.max(0, Math.floor(sample.durationMillis / 1_000)),
    );
    if (elapsedSeconds !== this.snapshot.elapsedSeconds) {
      this.publish({ ...this.snapshot, elapsedSeconds });
    }
  }

  private setAudioLevels(levels: ReadonlyArray<number>): void {
    this.audioLevels = levels;
    this.dependencies.publishAudioLevels(levels);
  }

  private publish(snapshot: VoiceInputSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function capturesAudio(phase: VoiceInputPhase): boolean {
  return phase === "preparing" || phase === "recording";
}
