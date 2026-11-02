#!/usr/bin/env bash
# Points nix/sources.json at an upstream nightly tag (vX.Y.Z-nightly.YYYYMMDD.N)
# and refreshes the pnpm dependency hash, which changes with pnpm-lock.yaml.
# Run after rebasing onto a new nightly: nix/update-sources.sh <tag>
set -euo pipefail

tag="${1:?usage: nix/update-sources.sh <upstream nightly tag>}"
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]]; then
  echo "Not an upstream nightly tag: $tag" >&2
  exit 1
fi
cd "$(dirname "$0")/.."

write_sources() {
  jq -n --arg version "${tag#v}" --arg hash "$1" '{version: $version, pnpmDepsHash: $hash}' > nix/sources.json
}

# An empty hash makes Nix fetch the dependencies and report what it got.
write_sources ""
hash="$({ nix build --no-link .#t3-server.pnpmDeps 2>&1 || true; } | sed -nE 's/^ +got: +(sha256-[A-Za-z0-9+/=]+)$/\1/p')"
if [[ -z "$hash" ]]; then
  echo "Could not compute the pnpm dependency hash." >&2
  exit 1
fi
write_sources "$hash"
echo "nix/sources.json: ${tag#v}, $hash"
