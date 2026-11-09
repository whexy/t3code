#!/bin/sh
# Model-checks the self-hosted push design (SelfHostedPush.tla) with TLC from
# the repo flake's pinned nixpkgs. Usage and meaning of each result:
# .agents/skills/verify-self-hosted-push/SKILL.md.
#
#   check.sh            single-fault design configs, then each design choice turned off
#   check.sh design     single-fault design configs only
#   check.sh variants   design choices turned off only
#   check.sh deep       every fault class at once (all-faults.cfg); much slower
#
# TLC output for every run stays in the printed directory.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
mode=${1:-all}
out=$(mktemp -d "${TMPDIR:-/tmp}/self-hosted-push-check.XXXXXX")
cp "$here/SelfHostedPush.tla" "$out/"
failed=0

run_tlc() { # name cfg
  [ "$2" = "$out/$1.cfg" ] || cp "$2" "$out/$1.cfg"
  rm -rf "$out/states"
  # TLC resolves -config next to the spec, so both live in $out.
  (cd "$out" && nix shell --inputs-from "$repo" nixpkgs#tlaplus -c \
    tlc -workers auto -metadir states -config "$1.cfg" SelfHostedPush.tla) \
    >"$out/$1.out" 2>&1 || true
  rm -rf "$out/states"
}

verdict() { # name -> "pass", "<Rule>", or "error"
  if grep -q "No error has been found" "$out/$1.out"; then
    echo pass
  elif rule=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated\.$/\1/p' "$out/$1.out" | head -n 1) &&
    [ -n "$rule" ]; then
    echo "$rule"
  else
    echo error
  fi
}

case $mode in
all | design) faults="crash apns timeout" ;;
deep) faults=all-faults ;;
variants) faults= ;;
*) echo "usage: $0 [design|variants|deep]" >&2 && exit 2 ;;
esac

if [ -n "$faults" ]; then
  for fault in $faults; do
    run_tlc "design-$fault" "$here/$fault.cfg"
    result=$(verdict "design-$fault")
    states=$(sed -n 's/^.* \([0-9]*\) distinct states found.*$/\1/p' "$out/design-$fault.out" | tail -n 1)
    if [ "$result" = pass ]; then
      echo "ok    design, $fault faults: every rule holds ($states states)"
    else
      echo "FAIL  design, $fault faults: $result (see $out/design-$fault.out)"
      failed=1
    fi
  done
fi

# Each design choice, turned off, must break the rule it exists for.
# Format: choice config expected-rule
if [ "$mode" = all ] || [ "$mode" = variants ]; then
  while read -r choice fault rule; do
    # Check only the guarded rule: with several broken, TLC's first report depends on its workers.
    sed -e "s/^  $choice = TRUE$/  $choice = FALSE/" -e "s/^INVARIANTS .*$/INVARIANTS $rule/" \
      "$here/$fault.cfg" >"$out/without-$choice.cfg"
    run_tlc "without-$choice" "$out/without-$choice.cfg"
    result=$(verdict "without-$choice")
    if [ "$result" = "$rule" ]; then
      echo "ok    without $choice: $rule breaks, as expected"
    else
      echo "FAIL  without $choice: expected $rule to break, got $result (see $out/without-$choice.out)"
      failed=1
    fi
  done <<'EOF'
SerializeDelivery apns NoMissedAlert
ReplyAfterDelivery crash CardShowsTruth
RetryForever crash PushKnowsTruth
ForgetOnFailure timeout PushKnowsTruth
WriteAheadSend apns NoDuplicateAlert
EOF
fi

echo "TLC output: $out"
exit "$failed"
