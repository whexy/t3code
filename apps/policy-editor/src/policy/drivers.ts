import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { acpRegistryClient } from "../../../../packages/provider-acp-registry/src/client.ts";
import { cursorClient } from "../../../../packages/provider-cursor/src/client.ts";
import { fxClient } from "../../../../packages/provider-fx/src/client.ts";
import { grokClient } from "../../../../packages/provider-grok/src/client.ts";
import { museClient } from "../../../../packages/provider-muse/src/client.ts";
import { openCodeClient } from "../../../../packages/provider-opencode/src/client.ts";
import { piClient } from "../../../../packages/provider-pi/src/client.ts";

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
