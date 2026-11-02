#!/usr/bin/env bash
# Builds one system's `t3-server` and checks the result runs and honors the
# per-user managed policy path. Leaves the `result` link.
#   scripts/self-hosted/nix-check.sh <system>
set -euo pipefail

installable=".#packages.${1:?usage: nix-check.sh <system>}.t3-server"
nix build -L --out-link result "$installable"
version="$(nix eval --raw "$installable.version")"
./result/bin/t3 --version | grep -Fx "t3 v$version"

# Resolved, since macOS's temp directory sits behind the /var symlink.
smoke="$(cd "$(mktemp -d)" && pwd -P)"
printf '{"schemaVersion":1,"organization":"Self-hosted CI"}' > "$smoke/policy.json"
T3CODE_DEV_MANAGED_POLICY_PATH="$smoke/policy.json" ./result/bin/t3 policy check "$smoke/policy.json" |
  tee "$smoke/check"
grep -qF "names $smoke/policy.json in place of this machine's policy." "$smoke/check"
HOME="$smoke" T3CODE_DEV_MANAGED_POLICY_PATH="$smoke/policy.json" \
  ./result/bin/t3 policy show --base-dir "$smoke/home" | tee "$smoke/show"
grep -qF "Managed by Self-hosted CI ($smoke/policy.json" "$smoke/show"
