#!/usr/bin/env bash
# Points nix/sources.json at an upstream nightly tag (vX.Y.Z-nightly.YYYYMMDD.N)
# and refreshes every hash the package pins, for every system it builds on:
# the Node release and pnpm that package.json names, and the pnpm
# dependencies, which change with pnpm-lock.yaml. Runs on x86_64-linux and
# pins macOS too, since none of these fetches depend on the machine running
# them. Run after rebasing onto a new nightly:
#   nix/update-sources.sh <tag>
set -euo pipefail

tag="${1:?usage: nix/update-sources.sh <upstream nightly tag>}"
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]]; then
  echo "Not an upstream nightly tag: $tag" >&2
  exit 1
fi
cd "$(dirname "$0")/.."

# <Nix system>:<the platform Node and pnpm release for>, as `platforms` in
# nix/t3-server.nix names them.
targets=(x86_64-linux:linux-x64 aarch64-darwin:darwin-arm64)

node_version="$(jq -r .engines.node package.json)"
pnpm_version="$(jq -r '.packageManager | ltrimstr("pnpm@")' package.json)"

sources='{}'
for target in "${targets[@]}"; do
  system="${target%%:*}" platform="${target#*:}"
  node_hash="$(nix store prefetch-file --json \
    "https://nodejs.org/dist/v$node_version/node-v$node_version-$platform.tar.xz" | jq -r .hash)"
  pnpm_hash="$(curl -fsSL "https://registry.npmjs.org/@pnpm%2Fexe.$platform/$pnpm_version" |
    jq -r .dist.integrity)"
  # An empty dependency hash makes Nix fetch them and report what it got.
  sources="$(jq --arg system "$system" --arg node "$node_hash" --arg pnpm "$pnpm_hash" \
    '.[$system] = {nodeHash: $node, pnpmHash: $pnpm, pnpmDepsHash: ""}' <<<"$sources")"
done
jq --arg version "${tag#v}" '{version: $version} + .' <<<"$sources" > nix/sources.json

for target in "${targets[@]}"; do
  system="${target%%:*}"
  deps_hash="$({ nix build --no-link ".#t3-server.pnpmDepsFor.$system" 2>&1 || true; } |
    sed -nE 's/^ +got: +(sha256-[A-Za-z0-9+/=]+)$/\1/p')"
  if [[ -z "$deps_hash" ]]; then
    echo "Could not compute the pnpm dependency hash for $system." >&2
    exit 1
  fi
  jq --arg system "$system" --arg deps "$deps_hash" '.[$system].pnpmDepsHash = $deps' \
    nix/sources.json > nix/sources.json.tmp
  mv nix/sources.json.tmp nix/sources.json
  echo "$system: deps $deps_hash"
done
echo "nix/sources.json: ${tag#v}, Node $node_version, pnpm $pnpm_version"
