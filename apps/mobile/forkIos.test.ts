import * as NodeFS from "node:fs";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", "preview");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return (await import("./app.config.ts")).default;
}

it("signs every iOS target for the fork and takes updates from its server", async () => {
  const config = await loadConfig({
    T3CODE_FORK_IOS: "1",
    T3CODE_FORK_IOS_BUILD_NUMBER: "42",
    T3CODE_MOBILE_UPDATES_ENABLED: "0",
  });

  expect(config.ios?.appleTeamId).toBe("26DMRHRW6Z");
  expect(config.ios?.bundleIdentifier).toBe("dev.whexy.t3code");
  expect(config.ios?.buildNumber).toBe("42");
  expect(config.ios?.entitlements).toEqual({
    "keychain-access-groups": ["$(AppIdentifierPrefix)dev.whexy.t3code"],
  });
  // A leftover upstream identifier makes automatic signing fail for the fork's team.
  expect(JSON.stringify([config.ios, config.plugins])).not.toMatch(/com\.t3tools|ARK85ZXQ4Z/);
  expect(JSON.stringify(config.plugins)).toContain('"groupIdentifier":"group.dev.whexy.t3code"');

  expect(config.updates).toMatchObject({
    enabled: true,
    url: "https://ota.clusters.work/t3code/manifest",
    requestHeaders: { "expo-channel-name": "production" },
  });
  expect(NodeFS.existsSync(new URL(config.updates!.codeSigningCertificate!, import.meta.url))).toBe(
    true,
  );
});

it("leaves the upstream build alone without T3CODE_FORK_IOS", async () => {
  const config = await loadConfig({});

  expect(config.ios?.appleTeamId).toBe("ARK85ZXQ4Z");
  expect(config.ios?.bundleIdentifier).toBe("com.t3tools.t3code.preview");
  expect(config.updates?.url).toMatch(/^https:\/\/u\.expo\.dev\//);
});
