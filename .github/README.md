# whexy/t3code

An unofficial fork of [T3 Code](https://github.com/pingdotgg/t3code) that
follows every upstream nightly and adds a few features for Wenxuan's
self-hosted fleet. For T3 Code itself (install, docs, issues), go to
[pingdotgg/t3code](https://github.com/pingdotgg/t3code).

## What the fork adds

| Feature        | What it does                                                                                                                                                                                                                                                                                                               | Ships as                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Client MCP     | An MCP server that works as a T3 Code client, so an MCP client can start and follow sessions on paired T3 servers. [`apps/mcp`](../apps/mcp)                                                                                                                                                                               | `ghcr.io/whexy/t3code-mcp`                                                   |
| Policy Editor  | Edits the fleet's named managed policies and serves each read-only at `/<name>.json`, which following hosts pick up within about 2 minutes. [`apps/policy-editor`](../apps/policy-editor)                                                                                                                                  | `ghcr.io/whexy/t3code-policy-editor` (private)                               |
| Web Hub        | The web client, with connections kept in a shared catalog instead of one browser. [`scripts/self-hosted`](../scripts/self-hosted)                                                                                                                                                                                          | `ghcr.io/whexy/t3code-hub`                                                   |
| Push relay     | t3-push sends the iOS app's notifications and Live Activity from the fleet's agent activity, replacing T3 Connect's relay. Hosts publish with `T3CODE_PUSH_URL` and `T3CODE_PUSH_TOKEN`; its design is model-checked in [`scripts/self-hosted/push-model`](../scripts/self-hosted/push-model). [`apps/push`](../apps/push) | `ghcr.io/whexy/t3code-push`, at `t3-push.clusters.work`                      |
| Server changes | `T3CODE_DEV_MANAGED_POLICY_PATH` gives each user their own managed policy file, and the `t3` server builds as a Nix package. [`nix`](../nix)                                                                                                                                                                               | `packages.{x86_64-linux,aarch64-darwin}.t3-server`, on Cachix                |
| iOS app        | The preview app built from the same commit as the fleet's server and signed for Wenxuan's Apple team. [`apps/mobile/forkIos.ts`](../apps/mobile/forkIos.ts)                                                                                                                                                                | TestFlight, `dev.whexy.t3code` `1.2.<run>`; updates from `ota.clusters.work` |
| Desktop app    | The nightly desktop app built from the fork, updating from this repository's releases instead of upstream's.                                                                                                                                                                                                               | Prereleases: Linux AppImage, Windows installer, signed macOS app             |

## How it stays current

![The rebase and build pipeline](assets/self-hosted-pipeline.svg)

These two are the only workflows enabled on the fork. Upstream's workflow
files come back with every rebase, so they stay in the repository and are
disabled in GitHub instead. The steps are in
[`self-hosted-rebase.yml`](workflows/self-hosted-rebase.yml),
[`self-hosted-build.yml`](workflows/self-hosted-build.yml) and
[`scripts/self-hosted`](../scripts/self-hosted).

## Branches and tags

- `self-hosted-nightly`, the default branch, is an upstream nightly tag, then
  the fork's commits, then one `chore(nix): pin sources for <tag>` commit.
  Every rebase replaces the pin commit, keeps it on top, and force-pushes the
  branch.
- `pin/<sha12>` tags each commit the build handed to the fleet, so it stays
  fetchable after the next force-push.
- Images are tagged `1.2.<run>` (the build workflow's run number, which only
  grows) and `sha-<sha12>`.

## Using it

The server, from the public cache:

```sh
nix run \
  --option extra-substituters https://whexy-t3code.cachix.org \
  --option extra-trusted-public-keys 'whexy-t3code.cachix.org-1:/pDSZMaQ8YHPw/og8nsuwxiYCAAcRB8JYEcmNd2Czyg=' \
  'github:whexy/t3code/<commit>#t3-server' -- --version
```

Pin a commit, not the branch, since the branch is force-pushed. As a flake
input, do not make it follow your `nixpkgs`: the cache holds only the paths
built from the fork's own lock.

The hub and MCP images are public on GHCR; take a `1.2.<run>` tag.

## The iOS app

Each published build also uploads the app to TestFlight, on GitHub's
`xcode-27` runner. It talks to T3 servers over the local network, the
tailnet or a public URL. T3 Connect sign-in, push notifications, Live
Activities and `app.t3.codes` links need upstream's hosted services and
Apple team, so they do not work in this build.

### Over-the-air updates

The app takes JavaScript updates from `ota.clusters.work` (app `t3code`,
channel `production`; operating the server is clusters-work's `docs/ota.md`).
To ship a change without a new build, run this from a tailnet machine with
dependencies installed and the publish token in `~/.config/ota/publish-token`:

```sh
scripts/self-hosted/ios-ota-publish.sh
```

The phone downloads the update at its next launch and runs it at the one
after; Settings → About then shows `1.2-ota.<commit>`. An update reaches only
builds with the same runtime version, the fingerprint of the native side, which
the script prints and each build's run summary records. When upstream changes
a native dependency, patch, plugin or the app config, the next TestFlight build
carries it, and updates for the older builds stop matching.

### Signing

The job skips until these repository secrets exist:

| Secret                 | Value                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| `IOS_DEVELOPMENT_P12`  | An Apple Development identity of team `26DMRHRW6Z`, as a base64 `.p12` |
| `IOS_DISTRIBUTION_P12` | An Apple Distribution identity of the same team, as a base64 `.p12`    |
| `IOS_P12_PASSWORD`     | The password of both `.p12` files                                      |
| `ASC_KEY_ID`           | An App Store Connect API key with the App Manager role                 |
| `ASC_ISSUER_ID`        | That key's issuer ID                                                   |
| `ASC_PRIVATE_KEY`      | That key's `.p8` contents                                              |

Xcode makes the development profiles for the archive through the API key. An
App Manager key cannot use Xcode's cloud-managed distribution signing, so the
export signs with one `IOS_APP_STORE` profile per bundle, made with the
distribution certificate (`asc profiles create`), which
[`ios-profiles.ts`](../scripts/self-hosted/ios-profiles.ts) installs. Those
profiles expire with the certificate, and an extension upstream adds later
fails the export until it has one.

These were made once by hand, because the public App Store Connect API cannot:
the app record for `dev.whexy.t3code`, and the App Group
`group.dev.whexy.t3code`, assigned to `dev.whexy.t3code` and its `.widgets` and
`.sharing` IDs in the Developer Portal. Without the group, every target fails
to provision. A build reaches internal testers without review.

## The desktop app

Each published build whose upstream nightly has no release yet builds the
desktop app through upstream's
[`release-desktop.yml`](workflows/release-desktop.yml) and publishes a
prerelease tagged with the bare version, such as `0.1.8-nightly.20261108.4380`.
The app keeps upstream's version, because clients compare nightly build
numbers with the servers' and the fleet's servers carry upstream's. Later
commits on the same nightly ship with the next one. A build made here points
its updater at this repository's releases, so an installed app updates from
them with no configuration. The newest 10 releases are kept.

It has no T3 Connect sign-in, like the rest of the fork. The Windows installer
is unsigned: SmartScreen warns on the first install, and updates install
without a signature check. It installs over upstream's nightly app, keeping its
settings. Linux hosts take the AppImage from dotfiles, which pins it, with the
app's own updater off.

### Signing the macOS app

A Mac app updates itself only when it is signed with a Developer ID, so the
macOS job skips until the signing secrets and variables below exist. Until
then a release carries Linux and Windows only.

| Secret or variable                         | Value                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `MACOS_DEVELOPER_ID_P12` (secret)          | A Developer ID Application identity of team `26DMRHRW6Z`, as a base64 `.p12`                  |
| `MACOS_DEVELOPER_ID_P12_PASSWORD` (secret) | Its password                                                                                  |
| `MACOS_PROVISIONING_PROFILE` (secret)      | A Developer ID provisioning profile for `MACOS_APP_ID` with Associated Domains, as base64     |
| `APPLE_TEAM_ID` (variable)                 | `26DMRHRW6Z`                                                                                  |
| `MACOS_APP_ID` (variable)                  | `dev.whexy.t3code.desktop`; a bundle id belongs to one team, so upstream's is not available   |
| `CLERK_PASSKEY_RP_DOMAINS` (variable)      | The `webcredentials:` domain the signed entitlements name; nothing uses it without T3 Connect |

Notarization uses the iOS job's `ASC_*` key. The app's signature differs from
upstream's, so on a Mac the fork's app replaces upstream's instead of updating
it, and anything upstream's app kept in the keychain has to be entered again.
