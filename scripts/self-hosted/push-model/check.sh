#!/bin/sh
# Model-checks the self-hosted push design (SelfHostedPush.tla) with TLC from
# the repo flake's pinned nixpkgs. Usage and meaning of each result:
# .agents/skills/verify-self-hosted-push/SKILL.md.
#
#   check.sh            design configs, each design choice turned off, then the open findings
#   check.sh design     design configs only
#   check.sh variants   design choices turned off only
#   check.sh findings   open findings only
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

# A copy of a config with one constant set and only one rule checked: with several
# broken, TLC's first report depends on its workers.
derive() { # source-cfg constant value rule dest
  sed -e "s/^  $2 = .*$/  $2 = $3/" -e "s/^INVARIANTS .*$/INVARIANTS $4/" "$here/$1.cfg" >"$5"
}

case $mode in
all | design) configs="crash apns timeout notes-crash notes-apns notes-timeout notes-touches modes modes-crash" ;;
deep) configs=all-faults ;;
variants | findings) configs= ;;
*) echo "usage: $0 [design|variants|findings|deep]" >&2 && exit 2 ;;
esac

for config in $configs; do
  run_tlc "design-$config" "$here/$config.cfg"
  result=$(verdict "design-$config")
  states=$(sed -n 's/^.* \([0-9]*\) distinct states found.*$/\1/p' "$out/design-$config.out" | tail -n 1)
  if [ "$result" = pass ]; then
    echo "ok    design, $config: every rule it lists holds ($states states)"
  else
    echo "FAIL  design, $config: $result (see $out/design-$config.out)"
    failed=1
  fi
done

# Each design choice, turned off, must break the rule it exists for.
# Format: choice config expected-rule
if [ "$mode" = all ] || [ "$mode" = variants ]; then
  while read -r choice config rule; do
    name="without-$choice-$rule"
    derive "$config" "$choice" FALSE "$rule" "$out/$name.cfg"
    run_tlc "$name" "$out/$name.cfg"
    result=$(verdict "$name")
    if [ "$result" = "$rule" ]; then
      echo "ok    without $choice: $rule breaks, as expected"
    else
      echo "FAIL  without $choice: expected $rule to break, got $result (see $out/$name.out)"
      failed=1
    fi
  done <<'EOF'
SerializeDelivery apns NoMissedAlert
ReplyAfterDelivery notes-crash NoMissedNotification
RetryForever crash PushKnowsTruth
ForgetOnFailure timeout PushKnowsTruth
WriteAheadSend apns NoDuplicateAlert
NotifyFromPublishedThread notes-apns NoMissedNotification
HonorLiveActivitiesOff modes CardEndsWhenLiveActivitiesOff
HonorLiveActivitiesOff modes OnlyEndWhenBothOff
AlertsNeedNotifications modes SilentWhenNotificationsOff
NotifyOncePerPhase notes-touches NoDuplicateNotification
StartupReconcile modes-crash CardEndsWhenLiveActivitiesOff
EndIsFinal apns NoMissedNotification
ReplayAlertsFromBaseline modes-crash NoMissedAlert
EOF
fi

# Each open finding must still break its rule on the design. A finding with a
# candidate fix must hold with that choice turned on. None is open; the list
# below is empty until a run finds one.
# Format: config rule fix-choice-or-dash
if [ "$mode" = all ] || [ "$mode" = findings ]; then
  while read -r config rule fix; do
    run_tlc "$config" "$here/$config.cfg"
    result=$(verdict "$config")
    if [ "$result" = "$rule" ]; then
      echo "open  $config: $rule breaks, as the finding says"
    else
      echo "FAIL  $config: expected $rule to break, got $result: is the finding fixed? (see $out/$config.out)"
      failed=1
    fi
    [ "$fix" = - ] && continue
    name="$config-with-$fix"
    derive "$config" "$fix" TRUE "$rule" "$out/$name.cfg"
    run_tlc "$name" "$out/$name.cfg"
    result=$(verdict "$name")
    if [ "$result" = pass ]; then
      echo "ok    $config with $fix: $rule holds"
    else
      echo "FAIL  $config with $fix: expected $rule to hold, got $result (see $out/$name.out)"
      failed=1
    fi
  done <<'EOF'
EOF
fi

echo "TLC output: $out"
exit "$failed"
