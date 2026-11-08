// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - A plain Node script the macOS runner runs once per build.
// Installs the App Store profile of every bundle in an archive and writes the
// export options that sign with them. Xcode's automatic export signing wants
// cloud-managed distribution certificates, which an API key gets only with the
// Admin role; the CI key is App Manager, so the export signs manually.
//   node ios-profiles.ts <archive> <export-options.plist>
// Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, IOS_TEAM_ID
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface Profile {
  readonly uuid: string;
  readonly bundleIdentifier: string;
  readonly expirationDate: string;
  readonly content: string;
}

export function selectProfiles(bundleIdentifiers: readonly string[], profiles: readonly Profile[]) {
  const selected = new Map<string, Profile>();
  for (const identifier of bundleIdentifiers) {
    const newest = profiles
      .filter((profile) => profile.bundleIdentifier === identifier)
      .toSorted((a, b) => b.expirationDate.localeCompare(a.expirationDate))[0];
    if (newest) selected.set(identifier, newest);
  }
  const missing = bundleIdentifiers.filter((identifier) => !selected.has(identifier));
  if (missing.length > 0) {
    throw new Error(
      `No active App Store profile for ${missing.join(", ")}. Create one with the distribution certificate: asc profiles create --profile-type IOS_APP_STORE`,
    );
  }
  return selected;
}

export function exportOptions(teamId: string, profiles: ReadonlyMap<string, Profile>) {
  const entries = [...profiles]
    .map(([identifier, profile]) => `<key>${identifier}</key><string>${profile.uuid}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>upload</string>
<key>signingStyle</key><string>manual</string>
<key>signingCertificate</key><string>Apple Distribution</string>
<key>teamID</key><string>${teamId}</string>
<key>manageAppVersionAndBuildNumber</key><false/>
<key>provisioningProfiles</key><dict>${entries}</dict>
</dict></plist>
`;
}

function apiToken(keyId: string, issuerId: string, keyPath: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({
    iss: issuerId,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  })}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(unsigned), {
    key: NodeFS.readFileSync(keyPath),
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

interface ProfilesResponse {
  readonly data: ReadonlyArray<{
    readonly attributes: {
      readonly uuid: string;
      readonly expirationDate: string;
      readonly profileContent: string;
    };
    readonly relationships: { readonly bundleId: { readonly data: { readonly id: string } } };
  }>;
  readonly included?: ReadonlyArray<{
    readonly type: string;
    readonly id: string;
    readonly attributes: { readonly identifier: string };
  }>;
}

async function fetchProfiles(token: string): Promise<Profile[]> {
  const response = await fetch(
    "https://api.appstoreconnect.apple.com/v1/profiles?filter[profileType]=IOS_APP_STORE&filter[profileState]=ACTIVE&include=bundleId&limit=200",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(`App Store Connect answered ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as ProfilesResponse;
  const identifiers = new Map(
    (body.included ?? [])
      .filter((item) => item.type === "bundleIds")
      .map((item) => [item.id, item.attributes.identifier]),
  );
  return body.data.flatMap(({ attributes, relationships }) => {
    const bundleIdentifier = identifiers.get(relationships.bundleId.data.id);
    return bundleIdentifier
      ? [
          {
            uuid: attributes.uuid,
            bundleIdentifier,
            expirationDate: attributes.expirationDate,
            content: attributes.profileContent,
          },
        ]
      : [];
  });
}

function archivedBundleIdentifiers(archive: string) {
  const bundles = NodeFS.readdirSync(NodePath.join(archive, "Products/Applications"), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory() && /\.(app|appex)$/.test(entry.name))
    .map((entry) => NodePath.join(entry.parentPath, entry.name));
  return bundles.map((bundle) =>
    NodeChildProcess.execFileSync(
      "plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", NodePath.join(bundle, "Info.plist")],
      { encoding: "utf8" },
    ).trim(),
  );
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const [archive, optionsPath] = process.argv.slice(2);
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, IOS_TEAM_ID } = process.env;
  if (!archive || !optionsPath || !ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_PATH || !IOS_TEAM_ID) {
    throw new Error(
      "Usage: ASC_KEY_ID= ASC_ISSUER_ID= ASC_KEY_PATH= IOS_TEAM_ID= ios-profiles.ts <archive> <export-options.plist>",
    );
  }
  const selected = selectProfiles(
    archivedBundleIdentifiers(archive),
    await fetchProfiles(apiToken(ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH)),
  );
  // Xcode 16 and later read the second directory; older tools read the first.
  for (const directory of [
    "Library/MobileDevice/Provisioning Profiles",
    "Library/Developer/Xcode/UserData/Provisioning Profiles",
  ]) {
    const path = NodePath.join(NodeOS.homedir(), directory);
    NodeFS.mkdirSync(path, { recursive: true });
    for (const profile of selected.values()) {
      NodeFS.writeFileSync(
        NodePath.join(path, `${profile.uuid}.mobileprovision`),
        Buffer.from(profile.content, "base64"),
      );
    }
  }
  NodeFS.writeFileSync(optionsPath, exportOptions(IOS_TEAM_ID, selected));
  for (const [identifier, profile] of selected) console.log(`${identifier}: ${profile.uuid}`);
}
