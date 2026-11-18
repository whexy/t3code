import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export type VoiceComposerPresentation = {
  readonly leadingAction: "cancel" | null;
  readonly trailingAction: "mic" | "confirm";
  readonly showsSend: boolean;
  readonly statusKind: "active" | "error" | null;
  readonly statusLabel: string | null;
  readonly confirmationEnabled: boolean;
  readonly confirmationLabel: string;
};

export function resolveVoiceComposerPresentation(
  state: VoiceInputState,
  elapsedSeconds: number,
  resolve: MessageResolver = m,
): VoiceComposerPresentation {
  switch (state.phase) {
    case "idle":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: null,
        statusLabel: null,
        confirmationEnabled: false,
        confirmationLabel: resolve(msg("Finish dictation")),
      };
    case "error":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: "error",
        statusLabel: state.error,
        confirmationEnabled: false,
        confirmationLabel: resolve(msg("Finish dictation")),
      };
    case "preparing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: resolve(msg("Preparing", { $context: "voice input status" })),
        confirmationEnabled: false,
        confirmationLabel: resolve(msg("Finish dictation")),
      };
    case "recording": {
      const seconds = Math.max(0, Math.floor(elapsedSeconds));
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: resolve(
          msg("Recording {time}", {
            time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
          }),
        ),
        confirmationEnabled: true,
        confirmationLabel: resolve(msg("Finish dictation")),
      };
    }
    case "transcribing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: resolve(msg("Transcribing", { $context: "voice input status" })),
        confirmationEnabled: false,
        confirmationLabel: resolve(msg("Finish dictation")),
      };
    case "post-processing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: resolve(msg("Cleaning up", { $context: "voice input status" })),
        confirmationEnabled: true,
        confirmationLabel: resolve(msg("Skip cleanup")),
      };
  }
}
