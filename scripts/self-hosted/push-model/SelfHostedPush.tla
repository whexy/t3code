---------------------------- MODULE SelfHostedPush ----------------------------
(***************************************************************************)
(* The self-hosted push path: each fleet host's AgentAwarenessRelay        *)
(* publishes thread activity to one t3-push process, which merges it into  *)
(* the single Live Activity card and sends it to APNs for one iPhone.      *)
(*                                                                         *)
(* One thread per host. Phases are the aggregate row phases reduced to     *)
(* what changes the card or an alert: none (no row), run (starting,        *)
(* running, stale), ask (waiting_for_approval, waiting_for_input), done    *)
(* (completed, failed). Code anchors are in .agents/skills/                *)
(* verify-self-hosted-push/SKILL.md.                                       *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Hosts,              \* fleet hosts, one thread each
    MaxChanges,         \* phase changes per thread
    MaxCrashes,         \* t3-push process crashes or restarts
    MaxApnsFailures,    \* APNs sends that fail or time out
    MaxTimeouts,        \* host publishes abandoned after 10 seconds
    RetryBudget,        \* failed publishes a host retries before giving up
    RetryForever,       \* hosts retry a failed publish without a budget
    ReplyAfterDelivery, \* t3-push answers a publish only after its APNs send is recorded
    SerializeDelivery,  \* one delivery at a time: read rows, send, record
    StartupReconcile,   \* t3-push redelivers from its stored rows after a restart
    WriteAheadSend,     \* persist the aggregate being sent before sending it
    ForgetOnFailure     \* a failed publish clears the host's last acknowledged state

Boot     == <<"boot", 0>>   \* a delivery not caused by a publish: registration replay or startup
Unknown  == "unknown"       \* no acknowledged state: the next publish always sends
Phases   == {"none", "run", "ask", "done"}
Alerting == {"ask", "done"}
NoRows   == [h \in Hosts |-> "none"]
AllNone(r) == \A h \in Hosts : r[h] = "none"
\* Rows that move into an alerting phase (alertForAttentionTransition, alertForNewlyTerminal).
Entering(prev, next) == {h \in Hosts : next[h] \in Alerting /\ prev[h] # next[h]}

VARIABLES
    truth, changes,                                      \* fleet host threads
    pending, req, sentPhase, published, attempts, stamp, \* host publishers
    up, crashes, rows, lastKind, lastRows,               \* t3-push, persisted and in memory
    alertBase, unsure, queued, jobs, ambiguous, armed, apnsFailures,
    orphans, apnsQ,                                      \* APNs
    cardKind, cardRows, dupAlert, missedAlert            \* the iPhone card, and ghosts

hostVars  == <<truth, changes>>
pubVars   == <<pending, req, sentPhase, published, attempts, stamp>>
pushVars  == <<up, crashes, rows, lastKind, lastRows, alertBase, unsure, queued, jobs,
               ambiguous, armed, apnsFailures>>
apnsVars  == <<orphans, apnsQ>>
phoneVars == <<cardKind, cardRows, dupAlert, missedAlert>>
vars == <<hostVars, pubVars, pushVars, apnsVars, phoneVars>>

Msg(kind, r, alerts, afterAmbiguous) ==
    [kind |-> kind, rows |-> r, alerts |-> alerts, afterAmbiguous |-> afterAmbiguous]

TypeOK ==
    /\ truth \in [Hosts -> Phases] /\ rows \in [Hosts -> Phases]
    /\ req \in [Hosts -> {"none", "sent", "stored", "ok", "fail"}]
    /\ published \in [Hosts -> Phases \cup {Unknown}] /\ sentPhase \in [Hosts -> Phases]
    /\ lastKind \in {"nil", "agg", "ended"} /\ cardKind \in {"local", "agg", "ended"}
    /\ queued \subseteq (Hosts \X (0..MaxTimeouts)) \cup {Boot}

Init ==
    /\ truth = NoRows /\ changes = [h \in Hosts |-> 0]
    /\ pending = [h \in Hosts |-> FALSE] /\ req = [h \in Hosts |-> "none"]
    /\ sentPhase = NoRows /\ published = NoRows /\ attempts = [h \in Hosts |-> 0]
    /\ stamp = [h \in Hosts |-> 0]
    /\ up = TRUE /\ crashes = 0 /\ rows = NoRows
    \* The phone has just started the card and registered its token: no baseline yet,
    \* and registration queues a replay (MobileRegistrations.registerLiveActivity).
    /\ lastKind = "nil" /\ lastRows = NoRows
    /\ alertBase = NoRows /\ unsure = FALSE
    /\ queued = {Boot} /\ jobs = {} /\ ambiguous = FALSE /\ apnsFailures = 0
    /\ armed = TRUE   \* remote_started_at: inside the freshly armed grace window
    /\ orphans = {} /\ apnsQ = <<>>
    /\ cardKind = "local" /\ cardRows = NoRows /\ dupAlert = FALSE /\ missedAlert = FALSE

\* ---- Fleet host: a thread changes phase; the domain event enqueues a publish
\* and cancels the retry budget (enqueueThreadPublish -> cancelPublishRetry).
ThreadChanges(h) ==
    /\ changes[h] < MaxChanges
    /\ \E p \in Phases \ {truth[h]} : truth' = [truth EXCEPT ![h] = p]
    /\ changes' = [changes EXCEPT ![h] = @ + 1]
    /\ pending' = [pending EXCEPT ![h] = TRUE]
    /\ attempts' = [attempts EXCEPT ![h] = 0]
    /\ UNCHANGED <<req, sentPhase, published, stamp, pushVars, apnsVars, phoneVars>>

\* ---- Host publisher (publishThreadUnsafe): one request at a time per host;
\* skip when the projected state equals the last acknowledged one.
HostPublishes(h) ==
    /\ pending[h] /\ req[h] = "none"
    /\ pending' = [pending EXCEPT ![h] = FALSE]
    /\ IF truth[h] = published[h]
       THEN UNCHANGED <<req, sentPhase>>
       ELSE /\ req' = [req EXCEPT ![h] = "sent"]
            /\ sentPhase' = [sentPhase EXCEPT ![h] = truth[h]]
    /\ UNCHANGED <<published, attempts, stamp, hostVars, pushVars, apnsVars, phoneVars>>

\* processThreadPublish: success records the published identity; failure schedules
\* a retry from RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS until the budget runs out.
HostGetsReply(h) ==
    /\ req[h] \in {"ok", "fail"}
    /\ req' = [req EXCEPT ![h] = "none"]
    /\ IF req[h] = "ok"
       THEN /\ published' = [published EXCEPT ![h] = sentPhase[h]]
            /\ attempts' = [attempts EXCEPT ![h] = 0]
            /\ UNCHANGED pending
       ELSE /\ published' = IF ForgetOnFailure THEN [published EXCEPT ![h] = Unknown]
                                             ELSE published
            /\ IF RetryForever \/ attempts[h] < RetryBudget
               THEN /\ pending' = [pending EXCEPT ![h] = TRUE]
                    /\ attempts' = IF RetryForever THEN attempts
                                   ELSE [attempts EXCEPT ![h] = @ + 1]
               ELSE UNCHANGED <<pending, attempts>>
    /\ UNCHANGED <<sentPhase, stamp, hostVars, pushVars, apnsVars, phoneVars>>

\* publishState gives up after 10 seconds while t3-push may still be delivering.
HostTimesOut(h) ==
    /\ req[h] = "stored" /\ stamp[h] < MaxTimeouts
    /\ req' = [req EXCEPT ![h] = "fail"]
    /\ stamp' = [stamp EXCEPT ![h] = @ + 1]
    /\ UNCHANGED <<pending, sentPhase, published, attempts, hostVars, pushVars, apnsVars, phoneVars>>

\* ---- t3-push publish handler: store the row, queue a delivery.
PushStoresPublish(h) ==
    /\ up /\ req[h] = "sent"
    /\ rows' = [rows EXCEPT ![h] = sentPhase[h]]
    /\ queued' = queued \cup {<<h, stamp[h]>>}
    /\ req' = [req EXCEPT ![h] = IF ReplyAfterDelivery THEN "stored" ELSE "ok"]
    /\ UNCHANGED <<pending, sentPhase, published, attempts, stamp, hostVars,
                   up, crashes, lastKind, lastRows, alertBase, unsure, jobs,
                   ambiguous, armed, apnsFailures, apnsVars, phoneVars>>

PushIsDown(h) ==
    /\ ~up /\ req[h] = "sent"
    /\ req' = [req EXCEPT ![h] = "fail"]
    /\ UNCHANGED <<pending, sentPhase, published, attempts, stamp, hostVars, pushVars, apnsVars, phoneVars>>

\* Only the request whose own row the delivery read is answered.
AnswerCovered(covers) ==
    req' = [h \in Hosts |-> IF <<h, stamp[h]>> \in covers /\ req[h] = "stored" THEN "ok" ELSE req[h]]

\* ---- t3-push delivery: read every row, choose the card update
\* (chooseLiveActivityDelivery), attach alerts, send. Reading rows and starting
\* the HTTP/2 request is one step: no await separates them.
PushStartsDelivery ==
    /\ up /\ queued # {}
    /\ SerializeDelivery => jobs = {}
    /\ \E covers \in (IF SerializeDelivery THEN {queued} ELSE {{q} : q \in queued}) :
        LET agg == rows
            kind == IF AllNone(agg) THEN "end" ELSE "update"
            alerts == IF kind = "end" \/ lastKind # "agg" THEN {}
                      ELSE Entering(IF WriteAheadSend THEN alertBase ELSE lastRows, agg)
            nothingToSend ==
                \/ lastKind = "ended"                      \* the card is gone
                \/ AllNone(agg) /\ lastKind = "nil" /\ armed  \* freshly armed grace
                \/ lastKind = "agg" /\ lastRows = agg /\ ~unsure  \* unchanged aggregate
        IN /\ queued' = queued \ covers
           /\ IF nothingToSend
              THEN /\ AnswerCovered(covers)
                   /\ UNCHANGED <<jobs, alertBase, unsure>>
              ELSE /\ jobs' = jobs \cup {[stage |-> "sending", covers |-> covers,
                                         prevBase |-> alertBase,
                                         msg |-> Msg(kind, agg, alerts, ambiguous)]}
                   /\ alertBase' = agg
                   /\ unsure' = WriteAheadSend
                   /\ UNCHANGED req
    /\ UNCHANGED <<pending, sentPhase, published, attempts, stamp, hostVars,
                   up, crashes, rows, lastKind, lastRows, ambiguous, armed, apnsFailures, apnsVars,
                   phoneVars>>

\* APNs answers 200 and queues the payload for the device.
ApnsAccepts(j) ==
    /\ j \in jobs /\ j.stage = "sending"
    /\ apnsQ' = Append(apnsQ, j.msg)
    /\ jobs' = (jobs \ {j}) \cup {[j EXCEPT !.stage = "accepted"]}
    /\ UNCHANGED <<hostVars, pubVars, up, crashes, rows, lastKind, lastRows, alertBase, unsure, queued, ambiguous, armed, apnsFailures, orphans, phoneVars>>

\* APNs answers an error status: nothing reached the phone. The delivery is
\* queued again and its waiting publishes keep waiting.
ApnsRefuses(j) ==
    /\ j \in jobs /\ j.stage = "sending" /\ apnsFailures < MaxApnsFailures
    /\ apnsFailures' = apnsFailures + 1
    /\ jobs' = jobs \ {j}
    /\ queued' = queued \cup j.covers \cup {Boot}
    /\ alertBase' = IF WriteAheadSend THEN j.prevBase ELSE alertBase
    /\ UNCHANGED <<hostVars, pubVars, up, crashes, rows, lastKind, lastRows, unsure, ambiguous,
                   armed, apnsVars, phoneVars>>

\* The request times out: APNs may or may not have accepted it.
ApnsTimesOut(j) ==
    /\ j \in jobs /\ j.stage = "sending" /\ apnsFailures < MaxApnsFailures
    /\ apnsFailures' = apnsFailures + 1
    /\ jobs' = jobs \ {j}
    /\ queued' = queued \cup j.covers \cup {Boot}
    /\ ambiguous' = TRUE
    /\ \E reached \in BOOLEAN : apnsQ' = IF reached THEN Append(apnsQ, j.msg) ELSE apnsQ
    /\ UNCHANGED <<hostVars, pubVars, up, crashes, rows, lastKind, lastRows, alertBase, unsure,
                   armed, orphans, phoneVars>>

\* LiveActivities.markDelivery records the new baseline, then waiting publishes are answered.
PushRecordsDelivery(j) ==
    /\ j \in jobs /\ j.stage = "accepted"
    /\ lastKind' = IF j.msg.kind = "end" THEN "ended" ELSE "agg"
    /\ lastRows' = j.msg.rows
    /\ AnswerCovered(j.covers)
    /\ jobs' = jobs \ {j}
    /\ ambiguous' = FALSE
    /\ armed' = FALSE
    /\ unsure' = FALSE
    /\ UNCHANGED <<pending, sentPhase, published, attempts, stamp, hostVars, up, crashes, rows,
                   alertBase, queued, apnsFailures, apnsVars, phoneVars>>

\* The process dies: memory is lost, the SQLite rows and baseline stay. Requests
\* already written to APNs may still be accepted.
PushCrashes ==
    /\ up /\ crashes < MaxCrashes
    /\ up' = FALSE /\ crashes' = crashes + 1
    /\ jobs' = {} /\ queued' = {}
    /\ orphans' = orphans \cup {j.msg : j \in {k \in jobs : k.stage = "sending"}}
    /\ ambiguous' = (ambiguous \/ jobs # {})
    /\ req' = [h \in Hosts |-> IF req[h] \in {"sent", "stored"} THEN "fail" ELSE req[h]]
    /\ UNCHANGED <<pending, sentPhase, published, attempts, stamp, hostVars, rows, lastKind, lastRows,
                   alertBase, unsure, armed, apnsFailures, apnsQ, phoneVars>>

\* Assumption: a new pod starts seconds after the old one dies, so APNs has
\* already accepted or dropped every request the dead process wrote.
PushRestarts ==
    /\ ~up /\ orphans = {}
    /\ up' = TRUE
    /\ queued' = IF StartupReconcile THEN {Boot} ELSE {}
    /\ UNCHANGED <<hostVars, pubVars, crashes, rows, lastKind, lastRows, alertBase, unsure, jobs, ambiguous, armed, apnsFailures, apnsVars, phoneVars>>

\* Two minutes pass without a recorded delivery.
GraceExpires ==
    /\ armed
    /\ armed' = FALSE
    /\ UNCHANGED <<hostVars, pubVars, crashes, up, rows, lastKind, lastRows, alertBase, unsure,
                   queued, jobs, ambiguous, apnsFailures, apnsVars, phoneVars>>

\* The idle sweep cron (AgentActivityPublisher.endIdleLiveActivities) finds a
\* live card with nothing left to show and queues its end. It runs on every tick.
SweepDue == up /\ ~armed /\ lastKind # "ended" /\ AllNone(rows)

IdleSweep ==
    /\ SweepDue /\ Boot \notin queued
    /\ queued' = queued \cup {Boot}
    /\ UNCHANGED <<hostVars, pubVars, crashes, up, rows, lastKind, lastRows, alertBase, unsure,
                   jobs, ambiguous, armed, apnsFailures, apnsVars, phoneVars>>

ApnsAcceptsOrphan(m) ==
    /\ m \in orphans
    /\ orphans' = orphans \ {m} /\ apnsQ' = Append(apnsQ, m)
    /\ UNCHANGED <<hostVars, pubVars, pushVars, phoneVars>>

ApnsNeverGetsOrphan(m) ==
    /\ m \in orphans
    /\ orphans' = orphans \ {m}
    /\ UNCHANGED <<hostVars, pubVars, pushVars, apnsQ, phoneVars>>

\* ---- iPhone: APNs hands over payloads in the order it accepted them.
PhoneGetsPush ==
    /\ apnsQ # <<>>
    /\ LET m == Head(apnsQ)
           expected == IF cardKind = "agg" /\ m.kind = "update"
                       THEN Entering(cardRows, m.rows) ELSE {}
       IN /\ apnsQ' = Tail(apnsQ)
          /\ IF cardKind = "ended"
             THEN UNCHANGED phoneVars
             ELSE /\ cardKind' = IF m.kind = "end" THEN "ended" ELSE "agg"
                  /\ cardRows' = m.rows
                  /\ dupAlert' = (dupAlert \/ m.alerts \ expected # {})
                  /\ missedAlert' = (missedAlert \/ (expected \ m.alerts # {} /\ ~m.afterAmbiguous))
    /\ UNCHANGED <<hostVars, pubVars, pushVars, orphans>>

Quiescent ==
    /\ up /\ ~armed /\ ~SweepDue /\ queued = {} /\ jobs = {} /\ orphans = {} /\ apnsQ = <<>>
    /\ \A h \in Hosts : ~pending[h] /\ req[h] = "none"

Settled == Quiescent /\ UNCHANGED vars

Next ==
    \/ \E h \in Hosts : ThreadChanges(h) \/ HostPublishes(h) \/ HostGetsReply(h) \/ HostTimesOut(h)
                        \/ PushStoresPublish(h) \/ PushIsDown(h)
    \/ PushStartsDelivery
    \/ \E j \in jobs : ApnsAccepts(j) \/ ApnsRefuses(j) \/ ApnsTimesOut(j) \/ PushRecordsDelivery(j)
    \/ \E m \in orphans : ApnsAcceptsOrphan(m) \/ ApnsNeverGetsOrphan(m)
    \/ PushCrashes \/ PushRestarts \/ GraceExpires \/ IdleSweep
    \/ PhoneGetsPush
    \/ Settled

Spec == Init /\ [][Next]_vars

\* ---- Rules
\* Once everything settles, t3-push holds every host's current thread phase.
PushKnowsTruth == Quiescent => rows = truth

\* Once everything settles, a live card shows every host's current thread phase.
CardShowsTruth ==
    Quiescent =>
        CASE cardKind = "agg"   -> cardRows = truth
          [] cardKind = "local" -> AllNone(truth)
          [] OTHER              -> TRUE

\* The phone never buzzes for a row the card already showed in that phase.
NoDuplicateAlert == ~dupAlert

\* Every move of a card row into ask or done buzzes, except on a resend after
\* a t3-push crash or an APNs timeout left it unknown whether the first send arrived.
NoMissedAlert == ~missedAlert
=============================================================================
