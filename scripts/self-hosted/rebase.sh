#!/usr/bin/env bash
# Rebases dev onto an upstream stable release, pins nix/sources.json and
# pnpm-lock.yaml to it, and promotes dev to self-hosted-nightly: the state
# machine .github/workflows/self-hosted-rebase.yml runs. Run it from a copy
# outside the checkout, since the rebase rewrites this file.
#
# Env: TAG (optional stable tag; default the latest), PUSH_URL (authenticated
# remote URL), STATE_DIR (the stage, tag, start and result the failure report
# reads; `stage` names the operation that was running when the script died).
set -euo pipefail

branch="${BRANCH:-dev}"
target="${TARGET:-self-hosted-nightly}"
upstream_url="${UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}"
scripts="$(cd "$(dirname "$0")" && pwd)"
state_dir="${STATE_DIR:?}"
mkdir -p "$state_dir"

stable="" tag="" start="" result="" state="" promote=""
record() { printf '%s' "$2" > "$state_dir/$1"; }
enter() { record stage "$1"; }
finish() {
  local line="state=$state promote=$promote stable=$stable tag=$tag start=$start result=$result"
  echo "$line"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$line" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 0
}

budget=apps/server/src/provider/agentContextBudget.json

# Upstream regenerates these files in most releases, so a fork commit touching
# them conflicts on nearly every rebase. Each resolves mechanically; any other
# conflicted file leaves the rebase stopped for a repair run.
resolve_generated() {
  local conflicted file
  conflicted="$(git diff --name-only --diff-filter=U)"
  [[ -n "$conflicted" ]] || return 1
  while read -r file; do
    case "$file" in
      # PIN rewrites both.
      nix/sources.json) git checkout --theirs -- "$file" ;;
      pnpm-lock.yaml) git checkout --ours -- "$file" ;;
      # Measured byte counts: the fork commit's change applies on top of upstream's.
      "$budget")
        jq --argjson base "$(git show ":1:$file")" --argjson fork "$(git show ":3:$file")" \
          'with_entries(.value += $fork[.key] - $base[.key])' <(git show ":2:$file") > "$file"
        ;;
      *) return 1 ;;
    esac
    git add -- "$file"
  done <<< "$conflicted"
}

rebase_onto() {
  # Git 2.45+ writes `pick <sha> # <subject>`, older versions omit the `# `.
  GIT_SEQUENCE_EDITOR="sed -i -E '/^pick [0-9a-f]+ (# )?chore\\(nix\\): pin sources /s/^pick/drop/'" \
    git rebase -i --onto "$1" "$2" && return 0
  while resolve_generated; do
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

  stable="${TAG:-}"
  if [[ -z "$stable" ]]; then stable="$(node "$scripts/stable-release.ts")"; fi
  record tag "$stable"
  # Upstream cuts each stable release from a nightly. The fork pins that
  # nightly's tag, whose version keeps the fleet on the nightly update track
  # (nix/t3-server.nix appends the commit time, which needs a nightly version).
  tags="$(git ls-remote --tags upstream)"
  commit="$(awk -v ref="refs/tags/$stable" '$2 == ref || $2 == ref "^{}" { commit = $1 } END { print commit }' <<< "$tags")"
  tag="$(awk -v commit="$commit" '$1 == commit { sub(/^refs\/tags\//, "", $2); sub(/\^\{\}$/, "", $2); print $2 }' <<< "$tags" |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$' | sort -V | tail -n 1 || true)"
  if [[ ! "$stable" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ || -z "$commit" || -z "$tag" ]]; then
    echo "Not an upstream stable tag with a nightly at its commit: $stable" >&2
    exit 1
  fi
  record tag "$tag"
  git fetch --no-tags upstream "+refs/heads/main:refs/remotes/upstream/main" \
    "+refs/tags/$tag:refs/remotes/upstream/release"
  release="$(git rev-parse 'refs/remotes/upstream/release^{commit}')"
  base="$(git merge-base "$start" refs/remotes/upstream/main)"

  result="$start"
  record result "$result"
  if [[ "$release" == "$base" ]] &&
    jq -e --arg version "${tag#v}" '.version == $version' nix/sources.json > /dev/null; then
    state="NOOP(current)"
    break
  fi
  if [[ "$release" != "$base" ]] && git merge-base --is-ancestor "$release" "$base"; then
    state="NOOP(older)"
    break
  fi

  enter rebase
  rebase_onto "$release" "$base"

  # A replayed lockfile can merge cleanly yet miss entries. Every fork dependency
  # is catalog: or workspace:, so rebuilding upstream's lockfile for the fork's
  # packages adds their importers and nothing else.
  enter pin
  git checkout "$release" -- pnpm-lock.yaml
  npx -y "pnpm@$(jq -r '.packageManager | ltrimstr("pnpm@")' package.json)" \
    install --lockfile-only --ignore-scripts
  nix/update-sources.sh "$tag"
  git add nix/sources.json pnpm-lock.yaml
  if ! git diff --cached --quiet; then
    git commit -q --no-verify -m "chore(nix): pin sources for $tag"
  fi
  result="$(git rev-parse HEAD)"
  record result "$result"
  if [[ "$result" == "$start" ]]; then
    state="NOOP(current)"
    break
  fi

  enter push
  if output="$(git push --force-with-lease="$branch:$start" "${PUSH_URL:?}" "HEAD:refs/heads/$branch" 2>&1)"; then
    echo "$output"
    state=PUSHED
    break
  fi
  echo "$output" >&2
  if ! grep -q 'stale info' <<< "$output"; then exit 1; fi
  echo "$branch moved since $start; starting over (attempt $attempt)." >&2
done
if [[ -z "$state" ]]; then
  enter push-race
  exit 1
fi

# The target only ever holds dev commits (matched by author, author date and
# subject, which survive a rebase of dev; pins are regenerated) and promote
# merge commits, so replacing it with dev loses nothing; a commit pushed to it
# any other way stops the promote instead of vanishing.
enter promote
git fetch --no-tags origin "+refs/heads/$target:refs/remotes/origin/$target"
promoted="$(git rev-parse "refs/remotes/origin/$target")"
if [[ "$(git rev-parse "$promoted^{tree}")" == "$(git rev-parse "$result^{tree}")" ]]; then
  promote=current
  finish
fi
stray="$(
  awk 'FILENAME == ARGV[1] { known[$0]; next } !(substr($0, index($0, " ") + 1) in known) { print $1 }' \
    <(git log --no-merges --format='%ae %at %s' "$start" --not "$promoted") \
    <(git log --no-merges --format='%H %ae %at %s' --invert-grep \
      --grep='^chore(nix): pin sources for ' "$promoted" --not "$start")
)"
if [[ -n "$stray" ]]; then
  echo "$target has commits $branch never had; land them on $branch first:" >&2
  git log --no-walk --format='%h %s' --stdin <<< "$stray" >&2
  exit 1
fi
git push --force-with-lease="$target:$promoted" "${PUSH_URL:?}" "$result:refs/heads/$target"
promote=pushed
finish
