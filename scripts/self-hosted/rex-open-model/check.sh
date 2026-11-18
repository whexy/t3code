#!/bin/sh
# Model-checks the "Open in Rex" session lifecycle (OpenInRex.tla) with TLC
# from the repo flake's pinned nixpkgs. Usage and meaning of each result:
# .agents/skills/verify-open-in-rex/SKILL.md.
#
#   check.sh            everything below
#   check.sh design     the chosen design's configs only
#   check.sh variants   each design choice turned off only
#   check.sh approved   the design as first approved (every choice off): which rules break
#   check.sh accepted     the accepted exceptions: their full rules must still break
#   check.sh assumptions  each measured Rex behavior flipped: the rule resting on it must break
#   check.sh findings     open findings only
#
# TLC output for every run stays in the printed directory.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
mode=${1:-all}
out=$(mktemp -d "${TMPDIR:-/tmp}/rex-open-check.XXXXXX")
cp "$here/OpenInRex.tla" "$out/"
failed=0
choices="Holders TakeoverCheck AbandonOnlyOnFailure ClientDeadline WorktreeLock RestartRearm WriteAheadCreate OwnerLatch LatchPersisted"

run_tlc() { # name cfg [workers]
  [ "$2" = "$out/$1.cfg" ] || cp "$2" "$out/$1.cfg"
  rm -rf "$out/states"
  # TLC resolves -config next to the spec, so both live in $out.
  (cd "$out" && nix shell --inputs-from "$repo" nixpkgs#tlaplus -c \
    tlc -workers "${3:-auto}" -metadir states -config "$1.cfg" OpenInRex.tla) \
    >"$out/$1.out" 2>&1 || true
  rm -rf "$out/states"
}

verdict() { # name -> "pass", "<Rule>", or "error"
  if grep -q "No error has been found" "$out/$1.out"; then
    echo pass
  elif rule=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated\.$/\1/p' "$out/$1.out" | head -n 1) &&
    [ -n "$rule" ]; then
    echo "$rule"
  elif grep -q "Temporal properties were violated" "$out/$1.out"; then
    echo NoDangling
  else
    echo error
  fi
}

# A copy of a config with some constants set and only one rule checked: with
# several broken, TLC's first report depends on its workers.
derive() { # source-cfg rule dest constant=value...
  src=$1 rule=$2 dest=$3
  shift 3
  cp "$here/$src.cfg" "$dest"
  for kv in "$@"; do
    sed -i "s/^  ${kv%%=*} = .*$/  ${kv%%=*} = ${kv#*=}/" "$dest"
  done
  if [ "$rule" = NoDangling ]; then
    sed -i -e "s/^INVARIANTS .*$/INVARIANTS TypeOK/" -e "/^PROPERTY /d" "$dest"
    echo "PROPERTY NoDangling" >>"$dest"
  else
    sed -i -e "s/^INVARIANTS .*$/INVARIANTS $rule/" -e "/^PROPERTY /d" "$dest"
  fi
}

expect() { # name expected-verdict ok-text fail-text
  result=$(verdict "$1")
  if [ "$result" = "$2" ]; then
    echo "$3"
  else
    echo "FAIL  $4: got $result (see $out/$1.out)"
    failed=1
  fi
}

if [ "$mode" = all ] || [ "$mode" = design ]; then
  for config in faults drops clicks; do
    run_tlc "design-$config" "$here/$config.cfg"
    states=$(sed -n 's/^.* \([0-9]*\) distinct states found, 0 states left.*$/\1/p' "$out/design-$config.out" | tail -n 1)
    expect "design-$config" pass "ok    design, $config: every rule it lists holds (${states:-?} states)" \
      "design, $config: expected every rule to hold"
  done
fi

# Each design choice, turned off, must break the rule it exists for.
# Format: choice config expected-rule
if [ "$mode" = all ] || [ "$mode" = variants ]; then
  while read -r choice config rule; do
    name="without-$choice-$rule"
    derive "$config" "$rule" "$out/$name.cfg" "$choice=FALSE"
    run_tlc "$name" "$out/$name.cfg"
    expect "$name" "$rule" "ok    without $choice: $rule breaks, as expected" \
      "without $choice: expected $rule to break"
  done <<'EOF'
Holders faults SelectedKillOnlyWithoutSign
TakeoverCheck faults SelectedKillOnlyWithoutSign
AbandonOnlyOnFailure faults SelectedKillOnlyWithoutSign
ClientDeadline faults SelectedKillOnlyWithoutSign
WorktreeLock faults OneSessionPerWorktree
WorktreeLock faults KillsOnlyUnconfirmed
RestartRearm faults SelectedKillOnlyWithoutSign
WriteAheadCreate faults NoOrphan
WriteAheadCreate faults NoDangling
OwnerLatch drops NeverKillSignalled
LatchPersisted drops NeverKillSignalled
EOF
fi

# The design as first approved: every rule it breaks, one at a time.
if [ "$mode" = all ] || [ "$mode" = approved ]; then
  off=""
  for c in $choices; do off="$off $c=FALSE"; done
  for rule in NeverKillSelected NoOrphan NoDangling OneSessionPerWorktree KillsOnlyUnconfirmed; do
    name="approved-$rule"
    # shellcheck disable=SC2086
    derive faults "$rule" "$out/$name.cfg" $off
    run_tlc "$name" "$out/$name.cfg" 1
    expect "$name" "$rule" "ok    approved design: $rule breaks, as it did" \
      "approved design: expected $rule to break"
  done
fi

# Accepted exceptions (Wenxuan, 2026-11-18): the full rule must still break,
# while its scoped rule holds in the design configs. If a full rule starts to
# hold, the exception is gone: update the skill.
# Format: config full-rule scoped-rule
if [ "$mode" = all ] || [ "$mode" = accepted ]; then
  while read -r config rule scoped; do
    name="accepted-$config-$rule"
    derive "$config" "$rule" "$out/$name.cfg"
    run_tlc "$name" "$out/$name.cfg" 1
    expect "$name" "$rule" "ok    accepted: $rule breaks only as $scoped allows" \
      "accepted: expected $rule to break"
  done <<'EOF'
faults NeverKillOpenedByHand HandKillOnlyInAcceptedGaps
drops NeverKillSelected SelectedKillOnlyWithoutSign
EOF
fi

# Rex behavior the design relies on, measured on mudd (2026-11-18): flipped,
# the rule resting on it must break. A failure here means the model no longer
# depends on that behavior the way the skill says.
# Format: constant config expected-rule
if [ "$mode" = all ] || [ "$mode" = assumptions ]; then
  while read -r constant config rule; do
    name="assume-not-$constant-$rule"
    derive "$config" "$rule" "$out/$name.cfg" "$constant=FALSE"
    run_tlc "$name" "$out/$name.cfg"
    expect "$name" "$rule" "ok    if Rex did not ($constant): $rule breaks, as expected" \
      "if Rex did not ($constant): expected $rule to break"
  done <<'EOF'
HandOff drops SelectedKillOnlyWithoutSign
UnaskedNeverOwns drops NoFalseSign
EOF
fi

# Each open finding must still break its rule on the design. A finding with a
# candidate fix must hold with that choice turned on. None is open.
# Format: config rule fix-choice-or-dash
if [ "$mode" = all ] || [ "$mode" = findings ]; then
  while read -r config rule fix; do
    [ -n "$config" ] || continue
    name="finding-$config-$rule"
    derive "$config" "$rule" "$out/$name.cfg"
    run_tlc "$name" "$out/$name.cfg"
    expect "$name" "$rule" "open  $config: $rule breaks, as the finding says" \
      "$config: expected $rule to break: is the finding fixed?"
    [ "$fix" = - ] && continue
    name="finding-$config-$rule-with-$fix"
    derive "$config" "$rule" "$out/$name.cfg" "$fix=TRUE"
    run_tlc "$name" "$out/$name.cfg"
    expect "$name" pass "ok    $config with $fix: $rule holds" \
      "$config with $fix: expected $rule to hold"
  done <<'EOF'
EOF
fi

echo "TLC output: $out"
exit "$failed"
