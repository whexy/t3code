import { useState } from "react";

import {
  canReloadDevUpdates,
  devUpdatesAtom,
  reloadDevUpdates,
  resolveDevUpdatesBackend,
  setDevUpdatesEnabled,
} from "~/state/devUpdates";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { describeDevUpdates } from "./devUpdatesSettings.logic";
import { SettingsRow } from "./settingsLayout";

/** The fork's dev OTA lane, shown only where the desktop app or the hub serves one. */
export function DevUpdatesSettingsRow() {
  const query = useEnvironmentQuery(resolveDevUpdatesBackend() ? devUpdatesAtom : null);
  const [enabledBeforeChange, setEnabledBeforeChange] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const current = query.data;
  if (!current) return null;
  const view = describeDevUpdates({ ...current, enabledBeforeChange });

  const showError = (title: string, error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "Something went wrong.",
      }),
    );

  const toggle = (enabled: boolean) => {
    setSaving(true);
    void setDevUpdatesEnabled(enabled)
      .then(() => setEnabledBeforeChange((before) => before ?? current.state.enabled))
      .catch((error: unknown) => showError("Could not change dev updates", error))
      .finally(() => setSaving(false));
  };

  return (
    <SettingsRow
      id="dev-updates"
      title="Dev updates"
      description={view.description}
      control={
        <div className="flex items-center gap-2">
          {view.offerReload && canReloadDevUpdates() ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void reloadDevUpdates().catch((error: unknown) =>
                  showError("Could not reload", error),
                )
              }
            >
              Reload
            </Button>
          ) : null}
          <Switch
            checked={current.state.enabled}
            disabled={saving}
            onCheckedChange={(checked) => toggle(Boolean(checked))}
            aria-label="Dev updates"
          />
        </div>
      }
    />
  );
}
