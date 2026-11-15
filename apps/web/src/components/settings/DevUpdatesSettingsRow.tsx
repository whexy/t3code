import { useState } from "react";

import { devUpdatesAtom, resolveDevUpdatesBackend, setDevUpdatesEnabled } from "~/state/devUpdates";
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

  const toggle = (enabled: boolean) => {
    setSaving(true);
    void setDevUpdatesEnabled(enabled)
      .then(() => setEnabledBeforeChange((before) => before ?? current.state.enabled))
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not change dev updates",
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
      })
      .finally(() => setSaving(false));
  };

  return (
    <SettingsRow
      id="dev-updates"
      title="Dev updates"
      description={view.description}
      control={
        <div className="flex items-center gap-2">
          {view.offerReload ? (
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
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
