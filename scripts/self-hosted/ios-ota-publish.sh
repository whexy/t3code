#!/usr/bin/env bash
# Publish this checkout's app JavaScript to the fork's iOS builds:
#   scripts/self-hosted/ios-ota-publish.sh
#
# Every TestFlight build whose runtime version (printed below) matches this
# checkout's native side downloads the update at its next launch and runs it
# at the one after. A native change moves the runtime version, and only a new
# build carries that. Run it on the tailnet after `vp install`.
#
# Environment:
#   OTA_ADMIN               publishing API    default https://ota.at-basking.ts.net
#   OTA_PUBLISH_TOKEN_FILE  its bearer token  default ~/.config/ota/publish-token
set -euo pipefail

admin=${OTA_ADMIN:-https://ota.at-basking.ts.net}
token_file=${OTA_PUBLISH_TOKEN_FILE:-$HOME/.config/ota/publish-token}
[[ -r "$token_file" ]] || {
  echo "no publish token at $token_file (deimos keeps a copy; see clusters-work docs/ota.md)" >&2
  exit 1
}

cd "$(git rev-parse --show-toplevel)/apps/mobile"
sha=$(git rev-parse HEAD)
dirty=
if [[ -n "$(git status --porcelain)" ]]; then
  dirty=-dirty
fi

# Must match the ios-testflight job in .github/workflows/self-hosted-build.yml.
export APP_VARIANT=preview EXPO_NO_GIT_STATUS=1 EXPO_NO_TELEMETRY=1 T3CODE_FORK_IOS=1
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=8192}
# Shown as the app's version in Settings, About.
export T3CODE_MOBILE_VERSION="1.2-ota.${sha:0:7}$dirty"

runtime=$(node_modules/.bin/expo-updates runtimeversion:resolve --platform ios --workflow managed 2>/dev/null |
  tail -1 | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).runtimeVersion)')
echo "runtime version $runtime"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
node_modules/.bin/expo export --platform ios --output-dir "$tmp/dist" >"$tmp/export.log" 2>&1 || {
  cat "$tmp/export.log" >&2
  exit 1
}
node_modules/.bin/expo config --type public --json >"$tmp/expo-config.json"
tar -C "$tmp/dist" -czf "$tmp/dist.tgz" .

# The token reaches curl on a descriptor, never in a process's arguments.
curl -fsS -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$token_file")") \
  --form-string runtimeVersion="$runtime" \
  -F "dist=@$tmp/dist.tgz;type=application/gzip" \
  -F "expoConfig=@$tmp/expo-config.json;type=application/json" \
  --form-string message="$(git log -1 --format=%s)" --form-string gitCommit="$sha$dirty" \
  "$admin/api/apps/t3code/channels/production/updates" |
  node -e '
    for (const u of JSON.parse(require("fs").readFileSync(0)).updates)
      console.log("published " + u.id + " for " + u.platform + ", runtime " + u.runtimeVersion);
  '
