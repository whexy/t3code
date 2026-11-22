---
name: verify-open-in-rex
description: Model-check the fork's "Open in Rex" session lifecycle (the host's T3 server creates or reuses a worktree's Rex session, the Mac selects it, and the server kills a pending session nobody opened) with TLA+. Use before changing how the server records, leases, latches or reaps a Rex session, how the desktop app selects one or reports back, and whenever a change touches the files listed under "When to run".
---

# Verify Open in Rex

`scripts/self-hosted/rex-open-model/OpenInRex.tla` is a TLA+ model of "Open in Rex" ([user guide](../../../docs/user/open-in-rex.md)). A click on a Mac asks the host's T3 server for the worktree's Rex session. The server keeps its own record in `rex-sessions.json` (Rex sessions record no folder), reuses the recorded session when `rex ls` still lists it, or writes an intent and runs `rex new`, then records the session as pending with a 30 s lease per click. The desktop app runs `session.select` in the Mac's own Rex app and reports confirm or abandon. While the session is pending, the server reads its size owner every second and latches the first app it sees. When no click holds it any more, the server kills it unless it has a sign the session was opened: a confirm, an app owning the size now, or the latch.

TLC checks every order of steps in a small world: one worktree on one host, two Macs (A and B), two or three clicks, each Mac's Rex link and T3 link dropping and coming back, lost messages, inconclusive selects (timed out, or "not found" from an app that may still show the session), selects on a Mac nobody is at, failed `rex new` calls, sessions closed in Rex, sessions opened by hand in a Rex app, apps joining a block's `desired` list unasked, T3 server restarts, and clicks whose Mac-side work outlasts their lease.

## The rules

| Rule                          | In plain words                                                                                                                                                                                               | Harm when it breaks                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `NeverKillSignalled`          | Once a confirm or a latched size owner exists, the session is the user's and T3 never kills it.                                                                                                              | A shell the user opened and worked in disappears.                      |
| `SelectedKillOnlyWithoutSign` | T3 kills a session a Mac selected through Open in Rex only if the host never had any sign it was opened: every Mac that selected it went offline before a sign, or claimed no size because nobody was at it. | A session the user is looking at disappears.                           |
| `NoFalseSign`                 | Only an app that opened the session ever owns its size, so an app in `desired` unasked never makes a session look opened.                                                                                    | A session nobody opened is kept forever.                               |
| `HandKillOnlyInAcceptedGaps`  | T3 kills a session the user opened by hand in Rex only in the 1–2 s before that app's size request reaches the host, or after that Mac went offline before any sign.                                         | Same, for a session clicked in Rex's sidebar.                          |
| `KillsOnlyUnconfirmed`        | T3 kills only a session it created and nobody confirmed; never one the user had before the click.                                                                                                            | T3 kills the user's own or already-confirmed session.                  |
| `NoOrphan`                    | Every live session T3 created is confirmed, in the record, or about to be recorded by the request that made it.                                                                                              | A session nothing will ever clean up.                                  |
| `NoDangling` (liveness)       | Every session T3 created is eventually confirmed or gone.                                                                                                                                                    | Pending sessions pile up in every Mac's Rex sidebar.                   |
| `OneSessionPerWorktree`       | At most one live T3-created session per worktree.                                                                                                                                                            | Two Macs or a double click open two different shells for one worktree. |
| `NeverKillSelected`           | (full rule (a)) T3 never kills a session a Mac selected. Does not hold: see Accepted limitations.                                                                                                            |                                                                        |
| `NeverKillOpenedByHand`       | (full rule (a')) T3 never kills a session opened by hand. Does not hold: see Accepted limitations.                                                                                                           |                                                                        |

## Design choices

Each constant is a choice the code makes. `check.sh variants` turns each off on the design and expects the rule named here, checked alone, to break, so the check can still catch the choice being dropped. Every choice off is the design as first approved; `check.sh approved` records what it broke.

| Constant               | Code                                                                                                                                                                 | Breaks without it                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Holders`              | `reuse` adds the click to `holders` and arms its own lease; `leaseEnds` and `receiveAbandon` remove only that click; `reapOnce` returns while `holders` is non-empty | `SelectedKillOnlyWithoutSign`: A gives up, B reuses the pending session and selects it, A's end kills it before B's confirm arrives   |
| `TakeoverCheck`        | `reapOnce` confirms when `RexCli.takenOver` is true                                                                                                                  | `SelectedKillOnlyWithoutSign`: A selects, its confirm is late, the lease ends, the reaper kills                                       |
| `AbandonOnlyOnFailure` | `selectInApp` returns `notListed` for a `notFound` answer; `reportFor` in `apps/web/src/rex/rexEntry.logic.ts` maps `timedOut` and `notListed` to no report          | `SelectedKillOnlyWithoutSign`: the select times out or answers "not found", the app shows the session anyway, the abandon kills it    |
| `ClientDeadline`       | `selectInApp` in `apps/desktop/src/rex/select.ts` returns `expired` when more than `CLICK_DEADLINE_MS` passed since `clickedAt`                                      | `SelectedKillOnlyWithoutSign`: a late answer, a select near the lease's end, the kill lands before the size takeover                  |
| `WorktreeLock`         | `withLock(cwd)` around `receiveOpen`, `report`, `armLease`'s `leaseEnds`, `latchOwner`, and `startup` (lock taken in `make` before requests)                         | `OneSessionPerWorktree`: two clicks both run `rex new`; `KillsOnlyUnconfirmed`: a confirm lands between the reap's check and its kill |
| `RestartRearm`         | `startup` arms a lease per holder and reaps a pending record with none                                                                                               | `SelectedKillOnlyWithoutSign`: select, confirm in flight, restart, startup kills                                                      |
| `WriteAheadCreate`     | `writeIntent` before `rexNew`; `resolveIntent` finds the labelled session (from `startup`, `rexNew`'s `tapError`, `checkRecord`)                                     | `NoOrphan`, `NoDangling`: a crash between `rex new` and the record leaves a session nothing knows                                     |
| `OwnerLatch`           | `watchOwner` ticks every `OWNER_POLL` into `latchOwner`, which sets `saw`; `reapOnce` confirms on `rec.saw`                                                          | `NeverKillSignalled`: A owns the size for seconds, its confirm is lost, the Mac sleeps, the reaper kills                              |
| `LatchPersisted`       | `saw` in the pending `RexRecord` in `apps/server/src/rex/RexSessionStore.ts`                                                                                         | `NeverKillSignalled`: the latch is set, the server restarts, the Mac sleeps, startup's reap kills                                     |

## Accepted limitations

Wenxuan accepted both on 2026-11-18. Their full rules are kept in the spec and `check.sh accepted` expects them to break; the scoped rules state exactly what is accepted and must hold. A counterexample to `NeverKillSelected` or `NeverKillOpenedByHand` alone is not a new bug. A counterexample to a scoped rule is.

1. **A Mac that goes offline before the host has any sign the session was opened.** No confirm arrived and no size owner was seen, so the host cannot tell the session from one nobody opened. It has left a dangling session, whatever the reason: network, sleep, a closed lid. Cleaning it up is the intended behavior, not a bug. In practice this is a Mac that drops within about a second of the select and stays off until the lease ends, or a Mac nobody is at, whose app claims no size, when its confirm is also lost. Once a confirm or a latched owner exists, the session is the user's and must never be killed (`NeverKillSignalled`). Scoped rule: `SelectedKillOnlyWithoutSign`; full rule `NeverKillSelected` breaks in `drops.cfg`.
2. **The hand-select gap.** Every Rex app lists every session on the host, so the user can click a pending session nobody holds in the 1–2 s while the reaper checks its size owner and kills it, before the app's size request reaches the host. No host-side read can close that gap. Scoped rule: `HandKillOnlyInAcceptedGaps` (which also allows case 1 for a session opened by hand); full rule `NeverKillOpenedByHand` breaks in `faults.cfg`.

## Open findings

A finding is a rule `check.sh` expects to break on the code as it is, listed in its findings section with its candidate fix. The design configs leave that rule out so the other rules still get a full check.

None open.

When a fix lands, set its constant in every config, put the rule back in the design configs, add a variant line for the constant, and delete the finding.

## Scope

- **Bounds:** `faults.cfg`: two clicks (Mac A, Mac B), one of every fault except link drops: a lost message, a session closed in Rex, a T3 restart, an overrun, a hand select, an inconclusive select, a failed `rex new`, with `NoDangling`. `drops.cfg`: two clicks, two link drops (one before the host has a sign), a select on a Mac nobody is at, two unasked joins of `desired`, a lost message, a restart, a hand select; safety rules only. `clicks.cfg`: three clicks (A, B, A), a lost message, a closed session, an overrun, an inconclusive select, with `NoDangling`.
- **Abstractions:** session ids are click numbers. A Mac's app shows one session and owns at most one block size. Time is not a clock: a lease ends only after its click's window closed (the client is done, a select it gave up on has landed or been dropped, and a connected app has owned the size for one poll interval). `Overrun` is the fault where that does not hold; with `ClientDeadline` it can only happen before the client starts its select.
- **Assumed timing:** `LeaseDuration` (30 s) covers `CLICK_DEADLINE_MS` (10 s from the click, wall clock) plus `SELECT_BUDGET_MS` (10 s) plus a late select, the size takeover and one `OWNER_POLL` (about 3 s together). The server's lease starts after the client's clock does.
- **Rex behavior, measured on mudd (2026-11-18, `~/.knowledge/topics/rex/opening-sessions-in-the-app.md`):** an app that selects a session claims its size: it joins the block's `desired` list and owns the size, except on a Mac nobody is at, where it claims nothing (`ClaimFails`). Apps also join `desired` unasked (`AppWatches`) but never own the size that way; until a claim, the creating client owns it, which `RexCli.takenOver` does not count. When the owner disconnects, the size passes to a connected client still in `desired`, else to nobody. The model narrows that heir to an app that shows the session (`HandOff`, `UnaskedNeverOwns`); the measurement did not show whether an app that joined `desired` unasked can be the heir. `check.sh assumptions` flips each constant and shows the rule that rests on it break: without `UnaskedNeverOwns`, an unasked app can inherit the size of a session whose Mac went offline within a second of the select, and T3 keeps that session instead of cleaning it up (`NoFalseSign`); no kill rule breaks. A returning app claims the size of the session it shows again. Measured on deimos and golf (2026-11-22, Rex 0.1.0 (2061), server preview.22): `session.select` of a session the host created a moment before waits 5 s and answers `SessionNotFoundOnServerError` ("no host lists it"), though the app attached the session within milliseconds and sometimes shows it before or soon after that answer. So a `notFound` answer is inconclusive (`SelectInconclusive`), not a failure.
- **Assumed Rex behavior:** `rex new` and `rex kill` are each one step on the Rex server, and a `rex new` started before a T3 restart does not land after `startup`; session ids are never reused; a label `<worktree> t3-<clickId>` is unique.
- **Over-approximated:** a lease may end at any time after its window closed; the latch is taken only once a poll interval passed (the code may latch earlier); a restart loses every report in flight.
- **Not covered:** `rex` CLI failures (the code never counts a failed read as gone or unowned: a failed `isAlive` fails the click, a failed reap or intent lookup retries after another lease, a failed `latchOwner` read polls again); more than one worktree or host; `rex.status` and the folder check in `open`; clients without the desktop bridge (web and mobile only show the entry).

## When to run

Run it when a change touches:

- `apps/server/src/rex/RexSessions.ts` (any of `receiveOpen`, `checkRecord`, `reuse`, `writeIntent`, `rexNew`, `recordPending`, `receiveConfirm`, `receiveAbandon`, `leaseEnds`, `armLease`, `reap`, `reapOnce`, `latchOwner`, `watchOwner`, `resolveIntent`, `startup`, `withLock`, `LeaseDuration`, `OWNER_POLL`);
- `takenOver`, `listSessions`, `create` or `kill` in `apps/server/src/rex/RexCli.ts`;
- `RexRecord` or `set` in `apps/server/src/rex/RexSessionStore.ts`;
- `apps/desktop/src/rex/select.ts` (`selectInApp`, `classifySelect`, `CLICK_DEADLINE_MS`, `SELECT_BUDGET_MS`) or `select` in `apps/desktop/src/rex/DesktopRex.ts`;
- `openInRex` in `apps/web/src/rex/RexOpenInItem.tsx` or `reportFor` in `apps/web/src/rex/rexEntry.logic.ts`;
- `RexReportInput` or `RexSelectOutcome` in `packages/contracts/src/rex.ts`;
- the spec, its configs or `check.sh`.

## Run

```sh
scripts/self-hosted/rex-open-model/check.sh            # everything below
scripts/self-hosted/rex-open-model/check.sh design     # the design configs only
scripts/self-hosted/rex-open-model/check.sh variants   # each design choice turned off
scripts/self-hosted/rex-open-model/check.sh approved   # the design as first approved
scripts/self-hosted/rex-open-model/check.sh accepted   # the accepted limitations still break their full rules
scripts/self-hosted/rex-open-model/check.sh assumptions  # each measured Rex behavior flipped: the rule resting on it breaks
scripts/self-hosted/rex-open-model/check.sh findings   # open findings and their candidate fixes
```

It runs TLC from the repo flake's pinned nixpkgs (`nix shell --inputs-from . nixpkgs#tlaplus`), so nothing else needs installing. It prints one line per run and the directory holding the full TLC output, and exits non-zero on any unexpected result. The expected result is `ok` or `open` on every line.

On a 48-core machine the whole run takes about 11 minutes: `faults.cfg` explores 1.6M distinct states (1 minute), `drops.cfg` 75M (5 minutes), `clicks.cfg` 3.7M (3 minutes, liveness included). Run it on every relevant change. On a host where the T3 server can restart (a dotfiles host), run it in its own unit with `systemd-run --user` so a restart does not end it.

## Check a change

1. Compare the diff with the Code column of Design choices. If the change removes or bypasses one of those (for example, `reuse` no longer adding the click to `holders`), set that constant to what the code now does in `faults.cfg`, `drops.cfg` and `clicks.cfg`, and run `check.sh design`. A failure is a regression in the change: do not ship it, report the broken rule and its path (step 3), and set the constant back.
2. Otherwise run `check.sh` (every mode). Every line must read `ok` or `open`.
3. For each failing line, read the path (see Read a result), retell it in this repo's words, such as "A clicks, `recordPending` arms A's lease, A's select succeeds, the confirm is lost, A's Mac sleeps, `leaseEnds` runs `reapOnce`, which finds no owner and no `saw`, and kills", and replay it against the code, one step per action, with the coverage table.
4. A path the code cannot take means the model is wrong: fix the model and say what was wrong. A path the change makes possible is a bug in the change: do not ship it. A path the code could already take before the change, breaking a scoped rule, is a new finding: report it with the path, add it to the findings section of `check.sh`, and leave the rule out of the design configs it reaches. Never weaken a rule or flip a constant to make a run pass.
5. A path that breaks only `NeverKillSelected` or `NeverKillOpenedByHand` is an accepted limitation, and `check.sh accepted` already expects it. A path breaking a scoped rule is not.

When a variant line fails ("expected X to break, got pass"), the check has lost its power to catch that choice being dropped; find out why before trusting a pass. When an accepted line fails, the limitation is gone: confirm against the code and update Accepted limitations. When an assumptions line fails, the model no longer leans on that Rex behavior as the skill says: find out why. When Rex changes how it hands the size over, measure it again, update the constants and Scope, and rerun. When a finding line fails, the code may have fixed it: confirm against the code, then follow Open findings.

## Read a result

Read every result with the `/statechart` skill: give it the spec and the failing config, cut down (one fault class, fewer drops) when the config is too large for its single worker. It turns an invariant violation into the shortest path in plain words.

A run stops at the first rule it finds broken, so a design config that names several rules reports one. To learn whether another rule breaks too, copy the config with only that rule under `INVARIANTS`, as `check.sh` does for variants.

Without `/statechart`, read the trace in the `.out` file `check.sh` names: each `State n: <Action ...>` is one step. Click `r` runs on Mac A when odd and Mac B when even, and the session `rex new` makes for click `r` has id `r`. The variables that tell the story are `rec` (the record), `cl` and `got` (each click's client), `net` (reports in flight), `rexUp`, `shows`, `owner` and `desired` (the apps), `viaT3`, `byHand`, `dark`, `unattended` and `signal` (who opened the session and what the host could know), and `killed`.

## Change the verification

When a change is intended:

1. Update the actions in `OpenInRex.tla` that describe the changed code, and their rows in the coverage table. One atomic step in the model is one lock hold, or one Rex or client event, in the code.
2. Run `check.sh`. If a new design choice guards a rule, add a constant, set it in every config, and add a variant line in `check.sh`.
3. Move the sync commit below forward. Move it only after confirming that every row of the coverage table describes the code at the new commit.

## Coverage

The server's actions are functions in `apps/server/src/rex/RexSessions.ts` unless named otherwise. Each server action runs inside one `withLock(cwd)` hold; Reap and KillSession run inside the hold of the action that emptied `holders` (`ReapIfUnheld`).

| Model action                                                                                  | Code                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Click`                                                                                       | `openInRex` in `apps/web/src/rex/RexOpenInItem.tsx`: `clickedAt = Date.now()`, then the `rex.open` command                                                                                                                                                                              |
| `GetSession`                                                                                  | `rex.open` returning `{ clickId, sessionId }`; past the deadline `selectInApp` returns `expired` and `reportFor` sends abandon                                                                                                                                                          |
| `WaitTimesOut`                                                                                | `rex.open` failing (a `RexOpenError` or the transport): the toast, no report                                                                                                                                                                                                            |
| `SelectOk`                                                                                    | `selectInApp` (`apps/desktop/src/rex/select.ts`) on `ok`: `open -b com.superlogical.rex`, `selected`; `reportFor` sends confirm through `rex.report`, once                                                                                                                              |
| `SelectFails`                                                                                 | `selectInApp` returning `failed` (`error`, or the budget spent while a launched app has not connected) or `DesktopRex.select` failing; `reportFor` sends abandon                                                                                                                        |
| `SelectInconclusive`, `LateSelectLands`, `LateSelectDrops`                                    | `Effect.timeoutOption` in `select` in `apps/desktop/src/rex/DesktopRex.ts` ends the `rex do session.select` process (`timedOut`), or the app answers `notFound` (`notListed`, also when the budget ends on one); no report; the app may still act on the request                        |
| `WindowCloses`, `Overrun`                                                                     | time: `CLICK_DEADLINE_MS`, `SELECT_BUDGET_MS`, `LeaseDuration`, `OWNER_POLL` (see Scope)                                                                                                                                                                                                |
| `TakeSize`, `ClaimFails`, `AppWatches`, `RexDrops`, `RexReturns`, `HandSelect`, `SessionEnds` | the Rex apps and the user: an app claiming the block's size after a select, or not (nobody at the Mac); an app joining `desired` unasked; an app disconnecting (the size passes to an heir) and reconnecting; a session clicked in Rex's sidebar; a session closed or its shell exiting |
| `T3Drops`, `T3Returns`, `Lose`                                                                | the client's WebSocket to the T3 server                                                                                                                                                                                                                                                 |
| `ReceiveOpen`, `CheckRecord`                                                                  | `open` → `withLock(cwd)(receiveOpen)` → `checkRecord`: `store.get`, then `isAlive` (`RexCli.listSessions`)                                                                                                                                                                              |
| `Reuse`                                                                                       | `reuse`: adds the click to `holders` and `armLease` when the record is pending for that session                                                                                                                                                                                         |
| `WriteIntent`, `RexNew`, `RecordPending`                                                      | `writeIntent` (label `sessionLabel(worktree, clickId)`), `rexNew` (`RexCli.create`), `recordPending` (`store.set`, `armLease`, `watchOwner`)                                                                                                                                            |
| `RexNewFails`                                                                                 | `rexNew`'s `tapError` → `resolveIntentOrRetry` → `resolveIntent`: the label in `RexCli.listSessions`, then a pending record with no holder, `watchOwner`, `reap`; the click fails                                                                                                       |
| `ReceiveConfirm`, `ReceiveAbandon`                                                            | `report` → `withLock` → `receiveConfirm` (pending for that session → confirmed) / `receiveAbandon` (removes the click, then `reap`)                                                                                                                                                     |
| `LeaseEnds`                                                                                   | `armLease`'s timer → `withLock` → `leaseEnds` (removes the click, then `reap`)                                                                                                                                                                                                          |
| `OwnerSettles`                                                                                | `watchOwner`'s tick → `withLock` → `latchOwner`: `RexCli.takenOver`, then `saw: true` (the model latches only after one poll interval)                                                                                                                                                  |
| `Reap`, `KillSession`                                                                         | `reap` → `reapOnce`: `isAlive`, `rec.saw` or `RexCli.takenOver` (owner in `desired`) → confirmed; else `RexCli.kill`, then `store.set(cwd, undefined)`                                                                                                                                  |
| `Restart`, `Startup`                                                                          | a server restart (leases, watchers and the lock are in memory); `startup` per record, under the lock `make` takes before any request: `resolveIntentOrRetry`, or `armLease` per holder, `watchOwner`, `reap` with no holder                                                             |
| `rec`                                                                                         | `RexRecord` in `apps/server/src/rex/RexSessionStore.ts`, persisted in `rex-sessions.json` by `set` before it returns                                                                                                                                                                    |

Last confirmed to describe the code at the commit that adds the `notListed` select outcome (on top of `8f65a1dae5` on `dev`), the latest commit touching the files under When to run. Move it forward only after confirming the coverage table against the new commit.
