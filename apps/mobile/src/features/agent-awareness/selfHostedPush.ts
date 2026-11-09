import { requireOptionalNativeModule } from "expo";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

export interface SelfHostedPushConfig {
  readonly url: string;
  readonly token: string;
}

type NativePushConfig = { readonly url?: string | null; readonly token?: string | null };

// The fork's iOS binary carries its t3-push origin and phone token in Info.plist, so OTA
// manifests never publish them. Builds without the module or keys keep upstream behavior.
export function resolveSelfHostedPushConfig(
  native: NativePushConfig | null = requireOptionalNativeModule<NativePushConfig>("T3PushConfig"),
): SelfHostedPushConfig | null {
  const url = native?.url ? normalizeSecureRelayUrl(native.url) : null;
  const token = native?.token?.trim();
  return url && token ? { url, token } : null;
}
