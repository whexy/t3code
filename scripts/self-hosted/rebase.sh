#!/usr/bin/env bash
# Rebases self-hosted-nightly onto an upstream nightly release and pins
# nix/sources.json to it: the state machine .github/workflows/rebase.yml runs.
# Run it from a copy outside the checkout, since the rebase rewrites this file.
#
# Env: TAG (optional; default the newest nightly), PUSH_URL (authenticated
# remote URL), STATE_DIR (the stage, tag, start and result the failure report
# reads; a run that ends without writing `failed` was stopped from outside).
set -euo pipefail

branch="${BRANCH:-self-hosted-nightly}"
upstream_url="${UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}"
scripts="$(cd "$(dirname "$0")" && pwd)"
state_dir="${STATE_DIR:?}"
mkdir -p "$state_dir"

stage=resolve tag="" start="" result=""
record() { printf '%s' "$2" > "$state_dir/$1"; }
on_exit() {
  local code=$?
  # 128+ means a signal: a timeout or cancel, which the report names itself.
  if ((code > 0 && code < 128)); then record failed "$stage"; fi
}
trap on_exit EXIT
finish() {
  local line="state=$1 tag=$tag start=$start result=$result"
  echo "$line"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$line" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 0
}

git remote get-url upstream > /dev/null 2>&1 || git remote add upstream "$upstream_url"

for attempt in 1 2; do
  stage=resolve
  git fetch --no-tags origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  start="$(git rev-parse "refs/remotes/origin/$branch")"
  record start "$start"
  git checkout -q --detach "$start"

  tag="${TAG:-}"
  if [[ -z "$tag" ]]; then tag="$(node "$scripts/nightly-release.ts")"; fi
  record tag "$tag"
  git fetch --no-tags upstream "+refs/heads/main:refs/remotes/upstream/main" \
    "+refs/tags/$tag:refs/remotes/upstream/release"
  release="$(git rev-parse 'refs/remotes/upstream/release^{commit}')"
  base="$(git merge-base "$start" refs/remotes/upstream/main)"

  if [[ "$release" == "$base" ]] &&
    jq -e --arg version "${tag#v}" '.version == $version' nix/sources.json > /dev/null; then
    result="$start"
    finish "NOOP(current)"
  fi
  if [[ "$release" != "$base" ]] && git merge-base --is-ancestor "$release" "$base"; then
    result="$start"
    finish "NOOP(older)"
  fi

  stage=rebase
  # Git 2.45+ writes `pick <sha> # <subject>`, older versions omit the `# `.
  GIT_SEQUENCE_EDITOR="sed -i -E '/^pick [0-9a-f]+ (# )?chore\\(nix\\): pin sources /s/^pick/drop/'" \
    git rebase -i --onto "$release" "$base"

  stage=pin
  nix/update-sources.sh "$tag"
  git add -A nix
  if ! git diff --cached --quiet; then
    git commit -q --no-verify -m "chore(nix): pin sources for $tag"
  fi
  result="$(git rev-parse HEAD)"
  record result "$result"
  if [[ "$result" == "$start" ]]; then finish "NOOP(current)"; fi

  stage=push
  if output="$(git push --force-with-lease="$branch:$start" "${PUSH_URL:?}" "HEAD:refs/heads/$branch" 2>&1)"; then
    echo "$output"
    finish PUSHED
  fi
  echo "$output" >&2
  if ! grep -q 'stale info' <<< "$output"; then exit 1; fi
  echo "$branch moved since $start; starting over (attempt $attempt)." >&2
done
stage=push-race
exit 1
