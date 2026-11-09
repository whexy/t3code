---
name: verify-self-hosted-push
description: Model-check the fork's self-hosted push path (fleet hosts publish agent activity to one t3-push process, which sends the iPhone's Live Activity card and alerts through APNs) with TLA+. Use before building or changing t3-push, and whenever a change touches AgentAwarenessRelay's publish, retry or dedupe logic, or the relay delivery logic t3-push reuses (ApnsDeliveries, AgentActivityPublisher, agentActivityAlerts, LiveActivities).
---

# Verify the self-hosted push path

`scripts/self-hosted/push-model/SelfHostedPush.tla` is a TLA+ model of the fork's replacement for T3 Connect's push relay. Each fleet host's `AgentAwarenessRelay` publishes thread activity to one `t3-push` process. `t3-push` merges every host's threads into the single Live Activity card, attaches alerts, and sends the card to APNs for one iPhone. TLC checks every order of steps in a small fleet, with crashes, APNs errors and host timeouts.

`t3-push` lives in `apps/push`. The model is its design contract: the **Design choices** below are what the implementation must do, and the coverage table maps each `t3-push` action to its code.

## The rules

| Rule               | In plain words                                                                                                                                                                       | Harm when it breaks                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `PushKnowsTruth`   | Once everything settles, `t3-push` holds every host's current thread phase.                                                                                                          | The card and every later alert are computed from a stale row until that thread changes again. |
| `CardShowsTruth`   | Once everything settles, a live card shows every host's current thread phase.                                                                                                        | The lock screen says "Working" for an agent that finished, or misses one that needs input.    |
| `NoDuplicateAlert` | The phone never buzzes for a row the card already showed in that phase.                                                                                                              | Double buzzes for one approval or one completion.                                             |
| `NoMissedAlert`    | Every move of a card row into "needs input/approval" or "done" buzzes, except on a resend after a `t3-push` crash or an APNs timeout left it unknown whether the first send arrived. | A finished or blocked agent goes unnoticed.                                                   |

"Settles" means `Quiescent` in the spec: `t3-push` is up, nothing is queued or in flight, no host has a publish pending, the freshly-armed grace window has passed, and no idle sweep is due.

Alerts are at most once. After an ambiguous send, the alert may be lost but never repeated. That matches upstream's delivery-claim behavior; `NoMissedAlert` states the exception rather than hiding it.

## Design choices the model requires

Each is a `CONSTANT` in the spec. `check.sh` turns each one off and confirms the rule it guards breaks.

| Choice               | What `t3-push` or the host must do                                                                                                                                                                                                        | Breaks without it                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SerializeDelivery`  | One delivery at a time per device: read all rows, send, record. Coalesce publishes queued meanwhile into the next delivery.                                                                                                               | `NoMissedAlert` (two deliveries compare with the same baseline and land in either order)                                                              |
| `ReplyAfterDelivery` | Answer a publish only after a delivery that read its row has been recorded. Answer per request, never per host: after a host timeout, the host's retry must not be answered by a delivery that read the rows before the retry was stored. | `CardShowsTruth` (a crash after "ok" loses the send, and the host never republishes)                                                                  |
| `WriteAheadSend`     | Before each APNs send, persist the aggregate being sent. Alerts compare with that persisted aggregate. The "unchanged aggregate" skip is off until the send is recorded.                                                                  | `NoDuplicateAlert` (a crash or timeout after APNs accepted the send rings the same alert again)                                                       |
| `RetryForever`       | **Host-side fork patch.** `processThreadPublish` keeps retrying a failed publish (capped backoff) instead of giving up after `RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS` (about 31 s).                                                         | `PushKnowsTruth` (a `t3-push` outage longer than the budget drops the thread's last state)                                                            |
| `ForgetOnFailure`    | **Host-side fork patch.** A failed publish clears the thread's entry in `publishedStateByThreadRef`, so the next publish always sends.                                                                                                    | `PushKnowsTruth` (`t3-push` stored the row before the failure. If the thread returns to the last acknowledged phase, the host skips it as unchanged.) |

`StartupReconcile` is off in the design. With `ReplyAfterDelivery`, the host's retry is the only retry loop. The alternative, answering right after the store, also passes if `StartupReconcile` is on (`t3-push` redelivers from SQLite on boot) and `t3-push` retries APNs errors itself. To check it, flip both constants in a scratch copy of each config.

The model also requires these behaviors, which it assumes rather than toggles:

- **A recurring idle sweep.** Like `endIdleLiveActivities`, it ends a card with nothing left to show, on every cron tick (`IdleSweep`). Without it, a send that lands after a crash can leave a "Working" row nobody clears.
- **Restart after the old pod is gone.** Use a `Recreate` rollout. `PushRestarts` requires that APNs has already settled every request the dead process wrote. A newer update from the new pod must not race an older one from the old pod.

## Scope

- **Bounds:** 2 hosts with one thread each, 2 phase changes per thread. Each design config allows one fault of one class. `crash.cfg` allows one `t3-push` crash, `apns.cfg` one APNs refusal or timeout, `timeout.cfg` one host publish timeout, and `all-faults.cfg` one of each.
- **Phases** are reduced to `none`, `run`, `ask` (approval or input) and `done` (completed or failed). Titles, model names and text changes are left out, and so is the 15 s throttle on changes that only touch them (`MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS`).
- **No clock.** Freshness windows (2 min terminal-alert freshness, the 15 min terminal-row TTL) and the host's 5 s confirmation hold for completions and tombstones (`publishConfirmDeadlines`) are not modeled. The 2 min freshly-armed grace is one `GraceExpires` step.
- **Assumed:** APNs delivers accepted payloads to the phone in acceptance order. A send that fails with an error status reached no one. A host sends one publish at a time (`makeAgentAwarenessPublishWorker`).
- **Not covered:** the phone re-registering or replacing its activity token, the user dismissing the card, APNs 410 token invalidation, plain push notifications when no card exists, Android/FCM, and more than one phone.

## When to run

Run it when a change touches:

- `apps/server/src/relay/AgentAwarenessRelay.ts`: `publishThreadUnsafe`, `processThreadPublish`, `schedulePublishRetry`, `RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS`, `makeAgentAwarenessPublishWorker`, or the `publishState` timeout;
- the relay delivery logic `t3-push` reuses (see the coverage table);
- the `t3-push` service, once it exists;
- the spec or its configs.

## Run

```sh
scripts/self-hosted/push-model/check.sh            # single-fault design configs, then each choice turned off
scripts/self-hosted/push-model/check.sh design     # single-fault design configs only
scripts/self-hosted/push-model/check.sh variants   # choices turned off only
scripts/self-hosted/push-model/check.sh deep       # all-faults.cfg: every fault class at once
```

It runs TLC from the repo flake's pinned nixpkgs (`nix shell --inputs-from . nixpkgs#tlaplus`), so no other install is needed. The first run downloads it. The script prints one line per run and the directory holding the full TLC output, and exits non-zero on any unexpected result.

The expected result is `ok` on every line: every design config passes, and every variant breaks the rule listed for it in `check.sh`. Each variant checks only that rule, because a variant can break several rules and TLC's first report would then depend on its worker scheduling.

On a 48-core machine the default run takes about 50 s, and the largest config explores 6.7M distinct states. Run the default on every relevant change. Run `deep` before relying on a design change and before moving the sync commit. At the sync commit it passes after 473M distinct states, in about 20 minutes on 32 TLC workers. It catches faults that only combine: the single-fault configs missed a gap that `all-faults.cfg` found (a crash right after the idle sweep ran, with a timed-out send landing later).

## Read a result

Read every result with the `/statechart` skill. Give it the spec and the failing config, or the passing one for a chart. It turns an invariant violation into the shortest path in plain words, and draws a pass as a chart of how the card moves between states.

When a design config fails:

1. Retell the path in this repo's words: "h1's thread finishes, the host publishes, t3-push stores the row and sends, APNs accepts, t3-push crashes before recording, …".
2. Replay it against the code, one step per action, using the coverage table. A path the code cannot take means the model is wrong: fix the model and say what was wrong. A path the code can take is a finding. Report it with the path, and do not weaken a rule or a constant to make it pass.
3. Until `t3-push` exists, a failure in its actions is a design finding. Change the **Design choices** section along with the spec, and say so.

When a variant line fails ("expected X to break, got pass"), the check has lost its power to catch that design choice being dropped. Find out why before trusting a pass.

## Change the verification

When a change is intended (new behavior in the host publisher, the reused relay logic, or `t3-push`):

1. Update the actions in `SelfHostedPush.tla` that describe the changed code, and their rows in the coverage table.
2. Run `check.sh`. If a new design choice guards a rule, add a variant line for it in `check.sh`.
3. Move the sync commit below only after you confirm that the spec describes the code at the new commit.

## Coverage

| Spec action                                  | Code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ThreadChanges`                              | `AgentAwarenessRelay.start` domain-event stream → `enqueueThreadPublish` (cancels the retry budget)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `HostPublishes`                              | `publishThreadUnsafe`: skip when `publishedStateByThreadRef` holds the same identity, else `publishState`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `HostGetsReply`                              | `schedulePublishRetry` keeps retrying at the last of `RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS` (`RetryForever`); the `catchCause` in `processThreadPublish` marks the thread `"unacknowledged"` in `publishedStateByThreadRef` (`ForgetOnFailure`)                                                                                                                                                                                                                                                                                          |
| `HostTimesOut`                               | `publishState`'s `Effect.timeout("10 seconds")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PushStoresPublish`, `PushIsDown`            | `apps/push/src/Push.ts` `publish`: `PushStore.upsertRow`/`deleteRow` and `enqueue` for every phone in one synchronous step, then waits on each phone's covering delivery. Models `AgentActivityPublisher.publish` → `rows.upsert`. `PushIsDown`: nothing listens, so the host's request fails.                                                                                                                                                                                                                                           |
| `PushStartsDelivery`                         | `apps/push/src/Push.ts` `drain` (one per phone: `SerializeDelivery`) → `deliver` → `prepare`, which in one synchronous step takes the queued requests (`covers`), reads every row into `makeAggregateState` (`agentActivityAggregate.ts`), chooses with `chooseDelivery` (`apps/push/src/cardDelivery.ts`, copied from `ApnsDeliveries.ts`; alerts from `alertForAttentionTransition`/`alertForNewlyTerminal` against `sent_aggregate_json`, no unchanged skip while `send_unsure`), and writes `PushStore.beginSend` (`WriteAheadSend`) |
| `ApnsAccepts`, `ApnsRefuses`, `ApnsTimesOut` | `Push.ts` `send` → `ApnsClient.sendLiveActivityRequest` over `apps/push/src/Http2Client.ts`. A refusal restores the baseline (`PushStore.restoreSent`) and `drain` retries; an `ApnsHttpRequestError` (timeout, broken connection) keeps it and retries                                                                                                                                                                                                                                                                                  |
| `PushRecordsDelivery`                        | `PushStore.recordDelivery` (as `LiveActivities.markDelivery`, clearing `send_unsure`), then `complete` answers the requests that delivery covered (`ReplyAfterDelivery`)                                                                                                                                                                                                                                                                                                                                                                 |
| `PushCrashes`, `PushRestarts`                | The `t3-push` process (`apps/push/src/bin.ts`; SQLite survives, `Push`'s queues do not) and its single-replica `Recreate` rollout (`apps/push/Dockerfile`; the cluster manifest is not in this repository)                                                                                                                                                                                                                                                                                                                               |
| `GraceExpires`                               | `FRESHLY_ARMED_GRACE_MS` in `isFreshlyArmed` (`apps/push/src/cardDelivery.ts`), which also ends at the first recorded delivery                                                                                                                                                                                                                                                                                                                                                                                                           |
| `IdleSweep`                                  | `Push.ts` `sweepIdle`, every minute from `sweepLayer`, as `AgentActivityPublisher.endIdleLiveActivities`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Init` (card armed, replay queued)           | `Push.ts` `registerLiveActivity` → `PushStore.registerLiveActivity` (baseline, `sent_aggregate_json` and `send_unsure` cleared, as `LiveActivities.register`) → `enqueue` of a replay                                                                                                                                                                                                                                                                                                                                                    |
| `PhoneGetsPush`                              | iOS ActivityKit applying a Live Activity update or end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Sync commit:** `df41dc609884969a365d97cb05388998635712f9`, plus the uncommitted `t3-push` work on top of it: the coverage rows above describe that working tree. Move the sync commit to the commit that lands this work, after rerunning `check.sh` and `check.sh deep` on it. The host side is configured by `T3CODE_PUSH_URL` and `T3CODE_PUSH_TOKEN` (`readSelfHostedPushTarget` in `apps/server/src/cloud/config.ts`).

For bringing this verification back in line after changes that skipped it, use `/maintain-formal-verification-skill`.
