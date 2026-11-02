#!/usr/bin/env bash
# Points nix/sources.json at an upstream nightly tag (vX.Y.Z-nightly.YYYYMMDD.N)
# and refreshes every hash the package pins: the Node release and pnpm that
# package.json names, and the pnpm dependencies, which change with
# pnpm-lock.yaml. Run after rebasing onto a new nightly:
#   nix/update-sources.sh <tag>
set -euo pipefail

tag="${1:?usage: nix/update-sources.sh <upstream nightly tag>}"
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]]; then
  echo "Not an upstream nightly tag: $tag" >&2
  exit 1
fi
cd "$(dirname "$0")/.."

node_version="$(jq -r .engines.node package.json)"
pnpm_version="$(jq -r '.packageManager | ltrimstr("pnpm@")' package.json)"
node_hash="$(nix store prefetch-file --json \
  "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz" | jq -r .hash)"
pnpm_hash="$(curl -fsSL "https://registry.npmjs.org/@pnpm%2Fexe.linux-x64/$pnpm_version" |
  jq -r .dist.integrity)"

write_sources() {
  jq -n --arg version "${tag#v}" --arg node "$node_hash" --arg pnpm "$pnpm_hash" --arg deps "$1" \
    '{version: $version, nodeHash: $node, pnpmHash: $pnpm, pnpmDepsHash: $deps}' > nix/sources.json
}

# An empty hash makes Nix fetch the dependencies and report what it got.
write_sources ""
deps_hash="$({ nix build --no-link .#t3-server.pnpmDeps 2>&1 || true; } |
  sed -nE 's/^ +got: +(sha256-[A-Za-z0-9+/=]+)$/\1/p')"
if [[ -z "$deps_hash" ]]; then
  echo "Could not compute the pnpm dependency hash." >&2
  exit 1
fi
write_sources "$deps_hash"
echo "nix/sources.json: ${tag#v}, Node $node_version, pnpm $pnpm_version, deps $deps_hash"
