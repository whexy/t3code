import type { ExpoConfig } from "expo/config";

// Upstream derives the extension, App Group and keychain identifiers from the
// variant's bundle ID, so rewriting that string re-signs every target for the
// fork's team, including identifiers upstream adds later.
export function withForkIosIdentity(config: ExpoConfig, env = process.env): ExpoConfig {
  const teamId = env.T3CODE_FORK_IOS_TEAM_ID?.trim();
  const bundleIdentifier = env.T3CODE_FORK_IOS_BUNDLE_ID?.trim();
  if (!teamId || !bundleIdentifier) return config;

  const upstreamIdentifier = config.ios?.bundleIdentifier;
  if (!upstreamIdentifier) throw new Error("The Expo config has no iOS bundle identifier.");
  const rewrite = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value).replaceAll(upstreamIdentifier, bundleIdentifier));
  const ios = rewrite(config.ios);

  return {
    ...config,
    ios: {
      ...ios,
      appleTeamId: teamId,
      buildNumber: env.T3CODE_FORK_IOS_BUILD_NUMBER?.trim() || ios?.buildNumber,
    },
    plugins: rewrite(config.plugins),
  };
}
