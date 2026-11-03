#!/usr/bin/env bash
# Rebases self-hosted-nightly onto an upstream nightly release and pins
# nix/sources.json to it: the state machine
# .github/workflows/self-hosted-rebase.yml runs. Run it from a copy outside the
# checkout, since the rebase rewrites this file.
#
# Env: TAG (optional; default the newest nightly), PUSH_URL (authenticated
# remote URL), STATE_DIR (the stage, tag, start and result the failure report
# reads; `stage` names the operation that was running when the script died).
set -euo pipefail

branch="${BRANCH:-self-hosted-nightly}"
upstream_url="${UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}"
scripts="$(cd "$(dirname "$0")" && pwd)"
state_dir="${STATE_DIR:?}"
mkdir -p "$state_dir"

tag="" start="" result=""
record() { printf '%s' "$2" > "$state_dir/$1"; }
enter() { record stage "$1"; }
finish() {
  local line="state=$1 tag=$tag start=$start result=$result"
  echo "$line"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$line" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 0
}

# A fork commit that edits nix/sources.json after the dropped pin commit, such
# as the one that keyed its hashes by system on its first rebase, conflicts
# there. PIN rewrites the file, so the fork's version stands in.
rebase_onto() {
  # Git 2.45+ writes `pick <sha> # <subject>`, older versions omit the `# `.
  GIT_SEQUENCE_EDITOR="sed -i -E '/^pick [0-9a-f]+ (# )?chore\\(nix\\): pin sources /s/^pick/drop/'" \
    git rebase -i --onto "$1" "$2" && return 0
  while [[ "$(git diff --name-only --diff-filter=U)" == nix/sources.json ]]; do
    git checkout --theirs nix/sources.json
    git add nix/sources.json
    GIT_EDITOR=true git rebase --continue && return 0
  done
  return 1
}

enter setup
git remote get-url upstream > /dev/null 2>&1 || git remote add upstream "$upstream_url"

for attempt in 1 2; do
  enter resolve
  git fetch --no-tags origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  start="$(git rev-parse "refs/remotes/origin/$branch")"
  record start "$start"
  git checkout -q --detach "$start"

  tag="${TAG:-}"
  if [[ -z "$tag" ]]; then tag="$(node "$scripts/nightly-release.ts")"; fi
  record tag "$tag"
  if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]]; then
    echo "Not an upstream nightly tag: $tag" >&2
    exit 1
  fi
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

  enter rebase
  rebase_onto "$release" "$base"

  enter pin
  nix/update-sources.sh "$tag"
  git add nix/sources.json
  if ! git diff --cached --quiet; then
    git commit -q --no-verify -m "chore(nix): pin sources for $tag"
  fi
  result="$(git rev-parse HEAD)"
  record result "$result"
  if [[ "$result" == "$start" ]]; then finish "NOOP(current)"; fi

  enter push
  if output="$(git push --force-with-lease="$branch:$start" "${PUSH_URL:?}" "HEAD:refs/heads/$branch" 2>&1)"; then
    echo "$output"
    finish PUSHED
  fi
  echo "$output" >&2
  if ! grep -q 'stale info' <<< "$output"; then exit 1; fi
  echo "$branch moved since $start; starting over (attempt $attempt)." >&2
done
enter push-race
exit 1
