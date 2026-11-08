import type { ExpoConfig } from "expo/config";

const TEAM_ID = "26DMRHRW6Z";
const BUNDLE_ID = "dev.whexy.t3code";

// clusters-work docs/ota.md. Installed builds trust only this certificate, so
// replacing it orphans them until they are rebuilt.
const UPDATES = {
  url: "https://ota.clusters.work/t3code/manifest",
  codeSigningCertificate: "./forkOtaCertificate.pem",
  codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
  requestHeaders: { "expo-channel-name": "production" },
} as const;

// Upstream derives the extension, App Group and keychain identifiers from the
// variant's bundle ID, so rewriting that string re-signs every target for the
// fork's team, including identifiers upstream adds later.
export function withForkIos(config: ExpoConfig, env = process.env): ExpoConfig {
  if (env.T3CODE_FORK_IOS !== "1") return config;

  const upstreamIdentifier = config.ios?.bundleIdentifier;
  if (!upstreamIdentifier) throw new Error("The Expo config has no iOS bundle identifier.");
  const rewrite = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value).replaceAll(upstreamIdentifier, BUNDLE_ID));
  const ios = rewrite(config.ios);

  return {
    ...config,
    ios: {
      ...ios,
      appleTeamId: TEAM_ID,
      buildNumber: env.T3CODE_FORK_IOS_BUILD_NUMBER?.trim() || ios?.buildNumber,
    },
    plugins: rewrite(config.plugins),
    updates: { ...config.updates, ...UPDATES, enabled: true },
  };
}
