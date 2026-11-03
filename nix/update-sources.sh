#!/usr/bin/env bash
# Points nix/sources.json at an upstream nightly tag (vX.Y.Z-nightly.YYYYMMDD.N)
# and refreshes every hash the package pins, for every system in `platforms`
# of nix/t3-server.nix: the Node release and pnpm that package.json names, and
# the pnpm dependencies, which change with pnpm-lock.yaml. None of these
# fetches depend on the machine running them, so one machine pins every
# system. nix/sources.json changes only once every hash is known. Run after
# rebasing onto a new nightly:
#   nix/update-sources.sh <tag>
set -euo pipefail

tag="${1:?usage: nix/update-sources.sh <upstream nightly tag>}"
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]]; then
  echo "Not an upstream nightly tag: $tag" >&2
  exit 1
fi
cd "$(dirname "$0")/.."
work="$(mktemp -d)"
# Beside nix/sources.json, so moving it into place is an atomic rename.
staged="$(mktemp nix/.sources.json.XXXXXX)"
trap 'rm -rf "$work" "$staged"' EXIT

node_version="$(jq -r .engines.node package.json)"
pnpm_version="$(jq -r '.packageManager | ltrimstr("pnpm@")' package.json)"
# "<Nix system> <the platform Node and pnpm release for>" per line.
targets="$(nix eval --json .#t3-server.platforms --apply 'builtins.mapAttrs (_: p: p.name)' |
  jq -r 'to_entries[] | "\(.key) \(.value)"')"

# The dependency fetches below run this machine's pnpm, so they evaluate the
# package against these new pins, not the ones nix/sources.json holds. An
# empty dependency hash makes Nix fetch them and report the hash it got.
sources="$(jq -n --arg version "${tag#v}" '{version: $version}')"
while read -r system platform <&3; do
  node_hash="$(nix store prefetch-file --json \
    "https://nodejs.org/dist/v$node_version/node-v$node_version-$platform.tar.xz" | jq -er .hash)"
  pnpm_hash="$(curl -fsSL "https://registry.npmjs.org/@pnpm%2Fexe.$platform/$pnpm_version" |
    jq -er .dist.integrity)"
  sources="$(jq --arg system "$system" --arg node "$node_hash" --arg pnpm "$pnpm_hash" \
    '.[$system] = {nodeHash: $node, pnpmHash: $pnpm, pnpmDepsHash: ""}' <<<"$sources")"
done 3<<<"$targets"

new="$sources"
while read -r system _ <&3; do
  log="$work/pnpm-deps-$system.log"
  # shellcheck disable=SC2016 # The ${...} are Nix's.
  nix build --no-link --impure \
    --argstr flake "git+file://$PWD" --argstr system "$system" --argstr sources "$sources" \
    --expr '{ flake, system, sources }:
      ((builtins.getFlake flake).packages.${builtins.currentSystem}.t3-server.override {
        sources = builtins.fromJSON sources;
      }).pnpmDepsFor.${system}' >"$log" 2>&1 || true
  deps_hash="$(sed -nE 's/^ +got: +(sha256-[A-Za-z0-9+/=]+)$/\1/p' "$log")"
  if [[ -z "$deps_hash" ]]; then
    cat "$log" >&2
    echo "Could not compute the pnpm dependency hash for $system." >&2
    exit 1
  fi
  new="$(jq --arg system "$system" --arg deps "$deps_hash" '.[$system].pnpmDepsHash = $deps' <<<"$new")"
  jq -r --arg system "$system" '.[$system] | "\($system): Node \(.nodeHash), pnpm \(.pnpmHash), deps \(.pnpmDepsHash)"' <<<"$new"
done 3<<<"$targets"

# Keeps the file's key order, so a pin only shows the values that changed.
jq --argjson new "$new" '({version: null} + . + $new) | with_entries(select(.key | in($new)))' \
  nix/sources.json >"$staged"
mv "$staged" nix/sources.json
echo "nix/sources.json: ${tag#v}, Node $node_version, pnpm $pnpm_version"
