#!/usr/bin/env bash
# Builds the editor and its container image locally, as the self-hosted policy
# editor pipeline does. Run from anywhere after `vp i`; pass a tag to override
# the default `t3code-policy-editor:local`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tag="${1:-t3code-policy-editor:local}"
docker="$(command -v docker || command -v podman)"

cd "$here"
../../node_modules/.bin/vp build
context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
cp serve.ts "$context/"
cp -R dist "$context/dist"
"$docker" build --platform linux/amd64 -f Dockerfile -t "$tag" "$context"
