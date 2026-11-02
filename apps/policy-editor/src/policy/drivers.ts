import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { fxClient } from "@t3tools/provider-fx/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

export interface KnownDriver {
  readonly id: ProviderDriverKind;
  readonly label: string;
  /** Whether a pin may set `binaryPath` and `launchArgs`, which land in the driver's config. */
  readonly binaryPath: boolean;
  readonly launchArgs: boolean;
}

const driver = (id: string, label: string, settings: { readonly fields: object }): KnownDriver => ({
  id: ProviderDriverKind.make(id),
  label,
  binaryPath: "binaryPath" in settings.fields,
  launchArgs: "launchArgs" in settings.fields,
});

/** The drivers `limits.providers` may name, built as the server's own list in managedProviders.ts is. */
export const KNOWN_DRIVERS: ReadonlyArray<KnownDriver> = [
  driver("codex", "Codex", CodexSettings),
  driver("claudeAgent", "Claude", ClaudeSettings),
  driver("antigravity", "Antigravity", AntigravitySettings),
  ...[
    cursorClient,
    grokClient,
    fxClient,
    museClient,
    openCodeClient,
    piClient,
    acpRegistryClient,
  ].map((client) => driver(client.driverKind, client.label, client.settingsSchema)),
];
