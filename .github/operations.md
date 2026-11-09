# Operating the fork

Procedures and traps for keeping [whexy/t3code](README.md)'s pipeline
running. The pipeline itself is in
[`self-hosted-rebase.yml`](workflows/self-hosted-rebase.yml),
[`self-hosted-build.yml`](workflows/self-hosted-build.yml),
[`self-hosted-promote-pr.yml`](workflows/self-hosted-promote-pr.yml) and
[`scripts/self-hosted`](../scripts/self-hosted).

## Workflows

Only the three `self-hosted-*` workflows are enabled. Upstream's workflow files
come back with every rebase, so they stay in the repository and are disabled in
GitHub instead. A disabled workflow can still be called, which is how the build
uses upstream's [`release-desktop.yml`](workflows/release-desktop.yml).

Retry a failed build with "Run workflow" on the branch head, never "Re-run":
a re-run reuses the run number, and the publishing jobs refuse it. Never rename
`self-hosted-build.yml`, since run numbers count per workflow file and a new
name would restart `1.2.<run>`.

## Renewals

| What                                                            | Expires    |
| --------------------------------------------------------------- | ---------- |
| iOS development and distribution certificates, and the profiles | 2027-11-08 |
| macOS Developer ID certificate and its provisioning profile     | 2027-12-09 |

Renew each before it expires and replace the matching secrets below; an
expired one fails its job.

## iOS app

The app talks to T3 servers over the local network, the tailnet, or a public
URL. T3 Connect sign-in and `app.t3.codes` links need upstream's hosted
services and Apple team, so they do not work in this build. Notifications and
the Live Activity come from the fork's push relay
([`apps/push`](../apps/push)).

The build writes the relay's URL and the `T3_PUSH_PHONE_TOKEN` secret into
Info.plist only. Never move them into Expo `extra`: `ota.clusters.work` serves
update manifests without authentication. Rotating the token therefore needs a
new TestFlight build. Without the secret, push stays off.

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
carries it, and updates for older builds stop matching.

### iOS signing

The `ios-testflight` job runs on GitHub's `xcode-27` runner and skips until
these repository secrets exist:

| Secret                 | Value                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| `IOS_DEVELOPMENT_P12`  | An Apple Development identity of team `26DMRHRW6Z`, as a base64 `.p12` |
| `IOS_DISTRIBUTION_P12` | An Apple Distribution identity of the same team, as a base64 `.p12`    |
| `IOS_P12_PASSWORD`     | The password of both `.p12` files                                      |
| `ASC_KEY_ID`           | An App Store Connect API key with the App Manager role                 |
| `ASC_ISSUER_ID`        | That key's issuer ID                                                   |
| `ASC_PRIVATE_KEY`      | That key's `.p8` contents                                              |
| `T3_PUSH_PHONE_TOKEN`  | The push relay's phone token; optional, see above                      |

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

## Desktop app

The app keeps upstream's version, because clients compare nightly build
numbers with the servers' and the fleet's servers carry upstream's. So there is
one prerelease per upstream nightly, tagged with the bare version such as
`0.1.8-nightly.20261108.4380`, and later commits on the same nightly ship with
the next one. A build made here points its updater at this repository's
releases, so an installed app updates from them with no configuration. The
newest 10 releases are kept.

It has no T3 Connect sign-in. The Windows installer is unsigned: SmartScreen
warns on the first install, and updates install without a signature check. It
installs over upstream's nightly app and keeps its settings.

The Mac app's signature differs from upstream's, so the fork's app replaces
upstream's instead of updating it, and anything upstream's app kept in the
keychain has to be entered again.

### macOS signing

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
| `MACOS_NOTARIZE` (variable)                | `false`, so the build leaves notarizing to the job after it                                   |

A Linux job notarizes the signed app after the build, with the iOS job's
`ASC_*` key and up to four attempts, so Apple being unreachable costs minutes
rather than a rebuild. The ticket is not stapled: the app's updater and
dotfiles' install never ask Gatekeeper, and Gatekeeper checks a downloaded app
with Apple online.
