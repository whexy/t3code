import * as Updates from "expo-updates";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  downloadDevBundle,
  isDevChannelSelected,
  isDevUpdatesSupported,
  reloadIntoSelectedBundle,
  selectDevChannel,
} from "./dev-updates";
import { deriveDevUpdatesState, needsReload, shortCommit } from "./dev-updates.logic";

export function DevUpdatesSection() {
  if (!isDevUpdatesSupported()) return null;
  return <DevUpdatesRows />;
}

function DevUpdatesRows() {
  const { currentlyRunning, downloadedUpdate } = Updates.useUpdates();
  const [enabled, setEnabled] = useState(isDevChannelSelected);
  const [phase, setPhase] = useState<"idle" | "checking" | "restarting">("idle");
  const state = deriveDevUpdatesState({
    enabled,
    runtimeVersion: currentlyRunning.runtimeVersion ?? null,
    running: currentlyRunning,
    downloaded: downloadedUpdate ?? null,
  });

  async function handleEnabledChange(next: boolean) {
    if (phase !== "idle") return;
    try {
      selectDevChannel(next);
    } catch (error) {
      Dialog.alert("Couldn't switch updates", errorMessage(error));
      return;
    }
    setEnabled(next);
    if (!next) return;

    setPhase("checking");
    let failure: string | null = null;
    let available = false;
    try {
      available = await downloadDevBundle();
    } catch (error) {
      failure = errorMessage(error);
    }
    setPhase("idle");
    if (available || state.running) return;
    // With no dev bundle on the device, every launch would wait on the server before falling back
    // to the build's bundle, so the switch only stays on once one is downloaded.
    selectDevChannel(false);
    setEnabled(false);
    Dialog.alert(
      failure ? "Couldn't get dev updates" : "No dev update yet",
      failure ?? `Nothing from dev has been published for ${state.runtimeVersion} yet.`,
    );
  }

  async function handleReload() {
    if (phase !== "idle") return;
    setPhase("restarting");
    try {
      await reloadIntoSelectedBundle();
    } catch (error) {
      setPhase("idle");
      Dialog.alert("Couldn't restart", errorMessage(error));
    }
  }

  const runningLabel = state.running ? `Dev · ${shortCommit(state.running)}` : "Built-in";
  const reloadLabel = state.pending
    ? `Reload into dev · ${shortCommit(state.pending)}`
    : "Reload into built-in";

  return (
    <SettingsSection
      title="Dev updates"
      footer="Client builds from the dev branch for this release. They run from the next launch; turning this off returns to the bundle this build shipped with."
    >
      <SettingsSwitchRow
        icon="wrench.and.screwdriver"
        label="Dev updates"
        subtitle={phase === "checking" ? "Checking…" : undefined}
        disabled={phase !== "idle"}
        value={state.enabled}
        onValueChange={(next) => void handleEnabledChange(next)}
      />
      <ListRowLayout icon="info.circle" label="Release" detail={state.runtimeVersion} />
      <ListRowLayout icon="git.commit" label="Running" detail={runningLabel} />
      {needsReload(state) ? (
        <SettingsRow
          icon="arrow.clockwise"
          label={phase === "restarting" ? "Restarting…" : reloadLabel}
          disabled={phase !== "idle"}
          onPress={() => void handleReload()}
        />
      ) : null}
    </SettingsSection>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
