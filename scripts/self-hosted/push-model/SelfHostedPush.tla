---------------------------- MODULE SelfHostedPush ----------------------------
(***************************************************************************)
(* The self-hosted push path: each fleet host's AgentAwarenessRelay        *)
(* publishes thread activity to one t3-push process, which merges it into  *)
(* the single Live Activity card, or into push notifications when the      *)
(* phone has no card, and sends them to APNs for one iPhone.               *)
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
    MaxTouches,         \* same-phase changes (a title or model change) the hosts still publish
    MaxCrashes,         \* t3-push process crashes or restarts
    MaxApnsFailures,    \* APNs sends that fail or time out
    MaxTimeouts,        \* host publishes abandoned after 10 seconds
    MaxPrefChanges,     \* phone re-registrations, each with any pair of switches
    StartModes,         \* the phone's switches at start: "both", "card", "notes", "off"
    RetryBudget,        \* failed publishes a host retries before giving up
    RetryForever,       \* hosts retry a failed publish without a budget
    ReplyAfterDelivery, \* t3-push answers a publish only after its APNs send is recorded
    SerializeDelivery,  \* one delivery at a time: read rows, send, record
    StartupReconcile,   \* t3-push redelivers from its stored rows after a restart
    WriteAheadSend,     \* persist the aggregate being sent before sending it
    ForgetOnFailure,    \* a failed publish clears the host's last acknowledged state
    HonorLiveActivitiesOff,    \* Live Activities off: end a leftover card and send no card updates
    AlertsNeedNotifications,   \* nothing rings while notifications are off
    NotifyFromPublishedThread, \* a notification comes from an owed publish, not the aggregate's first row
    NotifyOncePerPhase,        \* a thread's phase rings once: card alerts and notifications both mark it
    EndIsFinal,                \* from its first send an end is final: no card, resend it until APNs takes it
    ReplayAlertsFromBaseline,  \* a replay alerts like any delivery, against the persisted sent baseline
    AlertEveryEnteringRow      \* a card update alerts and marks every row entering ask or done, in one alert

Boot     == <<"boot", 0>>   \* a delivery not caused by a publish: registration replay, sweep or startup
Unknown  == "unknown"       \* no acknowledged state: the next publish always sends
Phases   == {"none", "run", "ask", "done"}
Alerting == {"ask", "done"}
NoRows   == [h \in Hosts |-> "none"]
NoSers   == [h \in Hosts |-> 0]
AllNone(r) == \A h \in Hosts : r[h] = "none"
\* Rows that move into an alerting phase (alertForAttentionTransition, alertForNewlyTerminal).
Entering(prev, next) == {h \in Hosts : next[h] \in Alerting /\ prev[h] # next[h]}
\* The rows a card update alerts (cardDelivery.ts alertedRows). Without AlertEveryEnteringRow,
\* upstream's alertForAttentionTransition ?? alertForNewlyTerminal: a completion in the same
\* update as a new approval neither rings nor is marked.
Alerted(prev, next) ==
    LET entering == Entering(prev, next)
        asks == {h \in entering : next[h] = "ask"}
    IN IF ~AlertEveryEnteringRow /\ asks # {} THEN asks ELSE entering
Range(s) == {s[i] : i \in DOMAIN s}
Without(s, h) == SelectSeq(s, LAMBDA x : x # h)
Min(S) == CHOOSE i \in S : \A k \in S : i <= k
Pick(S) == IF S = {} THEN "none" ELSE CHOOSE h \in S : TRUE

VARIABLES
    truth, changes, touches,                             \* fleet host threads
    pending, req, sentPhase, published, attempts, stamp, dirty, \* host publishers
    up, crashes, rows, lastKind, lastRows,               \* t3-push, persisted and in memory
                                                         \* (lastKind "ending": an end sent, unconfirmed)
    alertBase, unsure, queued, jobs, ambiguous, armed, apnsFailures,
    laOn, notifOn, prefChanges, noted,                   \* t3-push, the phone's registration
    owedQ, owedOld, lastStored,                          \* t3-push, owed notifications
    orphans, apnsQ,                                      \* APNs
    cardKind, cardRows, dupAlert, missedAlert,           \* the iPhone card, and ghosts
    rowSer, seenRead, owe, told, dupNote, rangOff, bothOffSent \* ghosts for notifications

hostVars  == <<truth, changes, touches>>
pubVars   == <<pending, req, sentPhase, published, attempts, stamp, dirty>>
cardVars  == <<up, crashes, rows, lastKind, lastRows, alertBase, unsure, queued, jobs,
               ambiguous, armed, apnsFailures>>
prefVars  == <<laOn, notifOn, prefChanges, noted>>
owedVars  == <<owedQ, owedOld, lastStored>>
pushVars  == <<cardVars, prefVars, owedVars>>
apnsVars  == <<orphans, apnsQ>>
phoneVars == <<cardKind, cardRows, dupAlert, missedAlert>>
ghostVars == <<rowSer, seenRead, owe, told, dupNote, rangOff, bothOffSent>>
vars == <<hostVars, pubVars, pushVars, apnsVars, phoneVars, ghostVars>>

\* A payload for APNs. `ser` names the row change each alerted host's alert is for.
Msg(kind, r, alerts, ser, afterAmbiguous, quiet) ==
    [kind |-> kind, rows |-> r, alerts |-> alerts, ser |-> ser,
     afterAmbiguous |-> afterAmbiguous, quiet |-> quiet]
SerOf(alerts) == [h \in Hosts |-> IF h \in alerts THEN rowSer[h] ELSE 0]
\* An owed thing is excused when the send that carried it may or may not have arrived.
Excused(o, m) == [h \in Hosts |-> IF h \in m.alerts /\ o[h] # 0 /\ m.ser[h] >= o[h] THEN 0 ELSE o[h]]

TypeOK ==
    /\ truth \in [Hosts -> Phases] /\ rows \in [Hosts -> Phases]
    /\ req \in [Hosts -> {"none", "sent", "stored", "ok", "fail"}]
    /\ published \in [Hosts -> Phases \cup {Unknown}] /\ sentPhase \in [Hosts -> Phases]
    /\ lastKind \in {"nil", "agg", "ending", "ended"} /\ cardKind \in {"local", "agg", "ended"}
    /\ queued \subseteq (Hosts \X (0..MaxTimeouts)) \cup {Boot}
    /\ laOn \in BOOLEAN /\ notifOn \in BOOLEAN /\ noted \in [Hosts -> BOOLEAN]
    /\ owedQ \in Seq(Hosts) /\ owedOld \subseteq Hosts /\ lastStored \in Hosts \cup {"none"}
    /\ rowSer \in [Hosts -> Nat] /\ owe \in [Hosts -> Nat] /\ told \in [Hosts -> Nat]

Init ==
    /\ truth = NoRows /\ changes = [h \in Hosts |-> 0] /\ touches = 0
    /\ pending = [h \in Hosts |-> FALSE] /\ req = [h \in Hosts |-> "none"]
    /\ sentPhase = NoRows /\ published = NoRows /\ attempts = [h \in Hosts |-> 0]
    /\ stamp = [h \in Hosts |-> 0] /\ dirty = [h \in Hosts |-> FALSE]
    /\ up = TRUE /\ crashes = 0 /\ rows = NoRows
    \* With Live Activities on, the phone has just started the card and registered its
    \* token: no baseline yet, inside the freshly armed grace window. With them off, it
    \* has no card. Registration queues a replay (MobileRegistrations.registerLiveActivity).
    /\ \E mode \in StartModes :
        LET withCard == mode \in {"both", "card"}
        IN /\ laOn = withCard /\ notifOn = (mode \in {"both", "notes"})
           /\ lastKind = (IF withCard THEN "nil" ELSE "ended")
           /\ armed = withCard
           /\ cardKind = (IF withCard THEN "local" ELSE "ended")
    /\ prefChanges = 0 /\ noted = [h \in Hosts |-> FALSE]
    /\ lastRows = NoRows /\ alertBase = NoRows /\ unsure = FALSE
    /\ queued = {Boot} /\ jobs = {} /\ ambiguous = FALSE /\ apnsFailures = 0
    /\ owedQ = <<>> /\ owedOld = {} /\ lastStored = "none"
    /\ orphans = {} /\ apnsQ = <<>>
    /\ cardRows = NoRows /\ dupAlert = FALSE /\ missedAlert = FALSE
    /\ rowSer = NoSers /\ seenRead = NoRows /\ owe = NoSers /\ told = NoSers
    /\ dupNote = FALSE /\ rangOff = FALSE /\ bothOffSent = FALSE

\* ---- Fleet host: a thread changes phase; the domain event enqueues a publish
\* and cancels the retry budget (enqueueThreadPublish -> cancelPublishRetry).
ThreadChanges(h) ==
    /\ changes[h] < MaxChanges
    /\ \E p \in Phases \ {truth[h]} : truth' = [truth EXCEPT ![h] = p]
    /\ changes' = [changes EXCEPT ![h] = @ + 1]
    /\ pending' = [pending EXCEPT ![h] = TRUE]
    /\ attempts' = [attempts EXCEPT ![h] = 0]
    /\ UNCHANGED <<touches, req, sentPhase, published, stamp, dirty, pushVars, apnsVars,
                   phoneVars, ghostVars>>

\* A change that keeps the phase (title, model): the projected identity differs, so the
\* host publishes the same phase again.
ThreadTouches(h) ==
    /\ touches < MaxTouches /\ truth[h] # "none"
    /\ touches' = touches + 1
    /\ pending' = [pending EXCEPT ![h] = TRUE]
    /\ dirty' = [dirty EXCEPT ![h] = TRUE]
    /\ attempts' = [attempts EXCEPT ![h] = 0]
    /\ UNCHANGED <<truth, changes, req, sentPhase, published, stamp, pushVars, apnsVars,
                   phoneVars, ghostVars>>

\* ---- Host publisher (publishThreadUnsafe): one request at a time per host;
\* skip when the projected state equals the last acknowledged one.
HostPublishes(h) ==
    /\ pending[h] /\ req[h] = "none"
    /\ pending' = [pending EXCEPT ![h] = FALSE]
    /\ IF truth[h] = published[h] /\ ~dirty[h]
       THEN UNCHANGED <<req, sentPhase, dirty>>
       ELSE /\ req' = [req EXCEPT ![h] = "sent"]
            /\ sentPhase' = [sentPhase EXCEPT ![h] = truth[h]]
            /\ dirty' = [dirty EXCEPT ![h] = FALSE]
    /\ UNCHANGED <<published, attempts, stamp, hostVars, pushVars, apnsVars, phoneVars, ghostVars>>

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
    /\ UNCHANGED <<sentPhase, stamp, dirty, hostVars, pushVars, apnsVars, phoneVars, ghostVars>>

\* publishState gives up after 10 seconds while t3-push may still be delivering.
HostTimesOut(h) ==
    /\ req[h] = "stored" /\ stamp[h] < MaxTimeouts
    /\ req' = [req EXCEPT ![h] = "fail"]
    /\ stamp' = [stamp EXCEPT ![h] = @ + 1]
    /\ UNCHANGED <<pending, sentPhase, published, attempts, dirty, hostVars, pushVars, apnsVars,
                   phoneVars, ghostVars>>

\* ---- t3-push publish handler: store the row, queue a delivery, and owe the
\* thread's notification (DeviceQueue.owed keeps each thread's latest publish).
PushStoresPublish(h) ==
    /\ up /\ req[h] = "sent"
    /\ LET moved == sentPhase[h] # rows[h]
       IN /\ rows' = [rows EXCEPT ![h] = sentPhase[h]]
          /\ rowSer' = IF moved THEN [rowSer EXCEPT ![h] = @ + 1] ELSE rowSer
          /\ noted' = IF moved THEN [noted EXCEPT ![h] = FALSE] ELSE noted
          /\ lastStored' = IF moved /\ ~NotifyFromPublishedThread THEN h ELSE lastStored
    /\ queued' = queued \cup {<<h, stamp[h]>>}
    /\ owedQ' = IF NotifyFromPublishedThread THEN Append(Without(owedQ, h), h) ELSE owedQ
    /\ owedOld' = owedOld \ {h}
    /\ req' = [req EXCEPT ![h] = IF ReplyAfterDelivery THEN "stored" ELSE "ok"]
    /\ UNCHANGED <<pending, sentPhase, published, attempts, stamp, dirty, hostVars,
                   up, crashes, lastKind, lastRows, alertBase, unsure, jobs,
                   ambiguous, armed, apnsFailures, laOn, notifOn, prefChanges,
                   apnsVars, phoneVars, seenRead, owe, told, dupNote, rangOff, bothOffSent>>

PushIsDown(h) ==
    /\ ~up /\ req[h] = "sent"
    /\ req' = [req EXCEPT ![h] = "fail"]
    /\ UNCHANGED <<pending, sentPhase, published, attempts, stamp, dirty, hostVars, pushVars,
                   apnsVars, phoneVars, ghostVars>>

\* Only the request whose own row the delivery read is answered.
AnswerCovered(covers) ==
    req' = [h \in Hosts |-> IF <<h, stamp[h]>> \in covers /\ req[h] = "stored" THEN "ok" ELSE req[h]]

\* A send finished. Without a card, the same drain loop goes again while
\* notifications are owed ("again"); otherwise the covered publishes are answered
\* and complete() drops the owed publishes this delivery read.
Finish(j) ==
    IF NotifyFromPublishedThread /\ j.notifies /\ owedQ # <<>>
    THEN /\ queued' = queued \cup j.covers
         /\ UNCHANGED <<req, owedQ, owedOld>>
    ELSE /\ AnswerCovered(j.covers)
         /\ owedQ' = SelectSeq(owedQ, LAMBDA x : x \notin owedOld)
         /\ owedOld' = {}
         /\ UNCHANGED queued

\* ---- t3-push delivery (Push.ts prepare): read every row, choose the card update
\* (chooseLiveActivityDelivery) with its alerts; without a card, take the owed
\* notifications in publish order until one rings. Reading rows and starting the
\* HTTP/2 request is one step: no await separates them.
PushStartsDelivery ==
    /\ up /\ queued # {}
    /\ SerializeDelivery => jobs = {}
    /\ \E covers \in (IF SerializeDelivery THEN {queued} ELSE {{q} : q \in queued}) :
        LET agg == rows
            replay == covers \subseteq {Boot}
            laOff == HonorLiveActivitiesOff /\ ~laOn
            hasCard == lastKind \notin {"ended", "ending"} /\ ~laOff
            mayRing == AlertsNeedNotifications => notifOn
            card == IF lastKind = "ended" THEN "none"           \* no activity token
                    ELSE IF lastKind = "ending" THEN "end"     \* sent, not yet confirmed
                    ELSE IF laOff THEN "end"
                    ELSE IF AllNone(agg)
                         THEN IF lastKind = "nil" /\ armed THEN "none" ELSE "end" \* grace
                    ELSE IF lastKind = "agg" /\ lastRows = agg /\ ~unsure THEN "none" \* unchanged
                    ELSE "update"
            cardRowsSent == IF card = "end" THEN NoRows ELSE agg
            alerts == IF card = "update" /\ lastKind = "agg" /\ (ReplayAlertsFromBaseline \/ ~replay) /\ mayRing
                      THEN Alerted(IF WriteAheadSend THEN alertBase ELSE lastRows, agg)
                      ELSE {}
            Rings(h) == agg[h] \in Alerting /\ mayRing /\ (NotifyOncePerPhase => ~noted[h])
            \* notificationForPublish over DeviceQueue.owed (takeNotification)
            ringing == {i \in DOMAIN owedQ : Rings(owedQ[i])}
            first == IF ringing = {} THEN 0 ELSE Min(ringing)
            \* Before the fix: chooseDelivery fell back to notificationForAggregate, which
            \* takes the aggregate's first row: needs input, else running, else the newest done.
            firstRow == IF \E h \in Hosts : agg[h] = "ask" THEN Pick({h \in Hosts : agg[h] = "ask"})
                        ELSE IF \E h \in Hosts : agg[h] = "run" THEN Pick({h \in Hosts : agg[h] = "run"})
                        ELSE IF lastStored # "none" /\ agg[lastStored] = "done" THEN lastStored
                        ELSE Pick({h \in Hosts : agg[h] = "done"})
            suppressed == ~laOff /\ lastKind = "agg" /\ ~AllNone(agg) /\ card = "none"
            note == IF card # "none" THEN "none"
                    ELSE IF NotifyFromPublishedThread
                         THEN IF ~hasCard /\ first # 0 THEN owedQ[first] ELSE "none"
                         ELSE IF ~suppressed /\ ~replay /\ firstRow # "none" /\ Rings(firstRow)
                              THEN firstRow ELSE "none"
            owedLeft == IF ~NotifyFromPublishedThread \/ card # "none" THEN owedQ
                        ELSE IF ~hasCard /\ first # 0 THEN SubSeq(owedQ, first + 1, Len(owedQ))
                        ELSE <<>>
            msg == IF card # "none"
                   THEN Msg(card, cardRowsSent, alerts, SerOf(alerts), ambiguous, ~notifOn)
                   ELSE Msg("note", NoRows, {note}, SerOf({note}), FALSE, FALSE)
            \* Ghost: each change of a thread into an alerting phase that a delivery reads is owed.
            seen == [h \in Hosts |-> IF agg[h] = seenRead[h] THEN owe[h]
                                     ELSE IF agg[h] \in Alerting /\ notifOn THEN rowSer[h] ELSE 0]
        IN /\ queued' = queued \ covers
           /\ lastKind' = IF EndIsFinal /\ card = "end" THEN "ending" ELSE lastKind
           /\ seenRead' = agg
           \* A missing baseline is a replay, not a transition that should buzz the phone.
           /\ owe' = IF card = "update" /\ lastKind # "agg" THEN NoSers ELSE seen
           /\ rangOff' = (rangOff \/ (~notifOn /\ (alerts # {} \/ note # "none")))
           /\ bothOffSent' = (bothOffSent \/
                  (~laOn /\ ~notifOn /\ (card = "update" \/ alerts # {} \/ note # "none")))
           /\ IF card = "none" /\ note = "none"
              THEN /\ AnswerCovered(covers)
                   /\ owedQ' = owedLeft
                   /\ owedOld' = {}
                   /\ UNCHANGED <<jobs, alertBase, unsure, noted>>
              ELSE /\ jobs' = jobs \cup {[stage |-> "sending", covers |-> covers,
                                         prevBase |-> IF card # "none" THEN alertBase ELSE NoRows,
                                         notifies |-> ~hasCard, msg |-> msg]}
                   /\ owedQ' = owedLeft
                   /\ owedOld' = IF NotifyFromPublishedThread THEN Range(owedLeft) ELSE {}
                   /\ IF card # "none"
                      THEN /\ alertBase' = cardRowsSent
                           /\ unsure' = WriteAheadSend
                           /\ noted' = IF NotifyOncePerPhase THEN [h \in Hosts |-> noted[h] \/ h \in alerts]
                                       ELSE noted
                      ELSE /\ noted' = IF NotifyOncePerPhase THEN [noted EXCEPT ![note] = TRUE]
                                       ELSE noted
                           /\ UNCHANGED <<alertBase, unsure>>
                   /\ UNCHANGED req
    /\ UNCHANGED <<pending, sentPhase, published, attempts, stamp, dirty, hostVars,
                   up, crashes, rows, lastRows, ambiguous, armed, apnsFailures,
                   laOn, notifOn, prefChanges, lastStored, apnsVars, phoneVars,
                   rowSer, told, dupNote>>

\* APNs answers 200 and queues the payload for the device. A notification needs no
\* record, so its send finishes here.
ApnsAccepts(j) ==
    /\ j \in jobs /\ j.stage = "sending"
    /\ apnsQ' = Append(apnsQ, j.msg)
    /\ IF j.msg.kind # "note"
       THEN /\ jobs' = (jobs \ {j}) \cup {[j EXCEPT !.stage = "accepted"]}
            /\ UNCHANGED <<req, queued, owedQ, owedOld>>
       ELSE /\ jobs' = jobs \ {j}
            /\ Finish(j)
    /\ UNCHANGED <<hostVars, pending, sentPhase, published, attempts, stamp, dirty,
                   up, crashes, rows, lastKind, lastRows, alertBase, unsure, ambiguous, armed,
                   apnsFailures, prefVars, lastStored, orphans, phoneVars, ghostVars>>

\* APNs answers an error status: nothing reached the phone. The delivery is
\* queued again and its waiting publishes keep waiting; a refused notification
\* goes back to the front of the owed publishes.
ApnsRefuses(j) ==
    /\ j \in jobs /\ j.stage = "sending" /\ apnsFailures < MaxApnsFailures
    /\ apnsFailures' = apnsFailures + 1
    /\ jobs' = jobs \ {j}
    /\ queued' = queued \cup j.covers \cup {Boot}
    /\ IF j.msg.kind # "note"
       THEN /\ alertBase' = IF WriteAheadSend THEN j.prevBase ELSE alertBase
            /\ noted' = IF NotifyOncePerPhase THEN [h \in Hosts |-> noted[h] /\ h \notin j.msg.alerts]
                        ELSE noted
            /\ UNCHANGED owedQ
       ELSE LET h == CHOOSE x \in j.msg.alerts : TRUE
            IN /\ owedQ' = IF NotifyFromPublishedThread THEN <<h>> \o Without(owedQ, h) ELSE owedQ
               /\ noted' = IF NotifyOncePerPhase THEN [noted EXCEPT ![h] = FALSE] ELSE noted
               /\ UNCHANGED alertBase
    /\ UNCHANGED <<hostVars, pubVars, up, crashes, rows, lastKind, lastRows, unsure, ambiguous,
                   armed, laOn, notifOn, prefChanges, owedOld, lastStored, apnsVars, phoneVars,
                   ghostVars>>

\* The request times out: APNs may or may not have accepted it. A card update is
\* retried without its alert; a notification is the alert itself, so it is dropped.
ApnsTimesOut(j) ==
    /\ j \in jobs /\ j.stage = "sending" /\ apnsFailures < MaxApnsFailures
    /\ apnsFailures' = apnsFailures + 1
    /\ jobs' = jobs \ {j}
    /\ \E reached \in BOOLEAN : apnsQ' = IF reached THEN Append(apnsQ, j.msg) ELSE apnsQ
    /\ owe' = Excused(owe, j.msg)
    /\ IF j.msg.kind # "note"
       THEN /\ queued' = queued \cup j.covers \cup {Boot}
            /\ ambiguous' = TRUE
            /\ UNCHANGED <<req, owedQ, owedOld>>
       ELSE /\ Finish(j)
            /\ UNCHANGED ambiguous
    /\ UNCHANGED <<hostVars, pending, sentPhase, published, attempts, stamp, dirty,
                   up, crashes, rows, lastKind, lastRows, alertBase, unsure, armed,
                   prefVars, lastStored, orphans, phoneVars,
                   rowSer, seenRead, told, dupNote, rangOff, bothOffSent>>

\* LiveActivities.markDelivery records the new baseline, then waiting publishes are answered.
PushRecordsDelivery(j) ==
    /\ j \in jobs /\ j.stage = "accepted"
    /\ lastKind' = IF j.msg.kind = "end" THEN "ended" ELSE "agg"
    /\ lastRows' = j.msg.rows
    /\ jobs' = jobs \ {j}
    /\ Finish(j)
    /\ ambiguous' = FALSE
    /\ armed' = FALSE
    /\ unsure' = FALSE
    /\ UNCHANGED <<pending, sentPhase, published, attempts, stamp, dirty, hostVars, up, crashes,
                   rows, alertBase, apnsFailures, prefVars, lastStored, apnsVars, phoneVars,
                   ghostVars>>

\* The process dies: memory is lost, the SQLite rows and baseline stay. Requests
\* already written to APNs may still be accepted.
PushCrashes ==
    /\ up /\ crashes < MaxCrashes
    /\ LET sending == {k \in jobs : k.stage = "sending"}
       IN /\ orphans' = orphans \cup {k.msg : k \in sending}
          /\ owe' = [h \in Hosts |-> IF \E k \in sending : Excused(owe, k.msg)[h] = 0
                                     THEN 0 ELSE owe[h]]
    /\ up' = FALSE /\ crashes' = crashes + 1
    /\ jobs' = {} /\ queued' = {} /\ owedQ' = <<>> /\ owedOld' = {}
    /\ ambiguous' = (ambiguous \/ \E k \in jobs : k.msg.kind # "note")
    /\ req' = [h \in Hosts |-> IF req[h] \in {"sent", "stored"} THEN "fail" ELSE req[h]]
    /\ UNCHANGED <<pending, sentPhase, published, attempts, stamp, dirty, hostVars, rows,
                   lastKind, lastRows, alertBase, unsure, armed, apnsFailures, prefVars,
                   lastStored, apnsQ, phoneVars,
                   rowSer, seenRead, told, dupNote, rangOff, bothOffSent>>

\* Assumption: a new pod starts seconds after the old one dies, so APNs has
\* already accepted or dropped every request the dead process wrote.
PushRestarts ==
    /\ ~up /\ orphans = {}
    /\ up' = TRUE
    /\ queued' = IF StartupReconcile THEN {Boot} ELSE {}
    /\ UNCHANGED <<hostVars, pubVars, crashes, rows, lastKind, lastRows, alertBase, unsure, jobs,
                   ambiguous, armed, apnsFailures, prefVars, owedVars, apnsVars, phoneVars,
                   ghostVars>>

\* Two minutes pass without a recorded delivery.
GraceExpires ==
    /\ armed
    /\ armed' = FALSE
    /\ UNCHANGED <<hostVars, pubVars, crashes, up, rows, lastKind, lastRows, alertBase, unsure,
                   queued, jobs, ambiguous, apnsFailures, prefVars, owedVars, apnsVars,
                   phoneVars, ghostVars>>

\* The idle sweep cron (AgentActivityPublisher.endIdleLiveActivities) finds a
\* live card with nothing left to show and queues its end. It runs on every tick.
SweepDue == up /\ ~armed /\ lastKind # "ended" /\ AllNone(rows)

IdleSweep ==
    /\ SweepDue /\ Boot \notin queued
    /\ queued' = queued \cup {Boot}
    /\ UNCHANGED <<hostVars, pubVars, crashes, up, rows, lastKind, lastRows, alertBase, unsure,
                   jobs, ambiguous, armed, apnsFailures, prefVars, owedVars, apnsVars,
                   phoneVars, ghostVars>>

\* The phone re-registers (registerDevice), with its switches changed or not, and
\* t3-push queues a replay. Turning notifications off cancels what was owed.
PhoneRegisters ==
    /\ up /\ prefChanges < MaxPrefChanges
    /\ \E la, n \in BOOLEAN :
        /\ laOn' = la /\ notifOn' = n
        /\ owe' = IF n THEN owe ELSE NoSers
    /\ prefChanges' = prefChanges + 1
    /\ queued' = queued \cup {Boot}
    /\ UNCHANGED <<hostVars, pubVars, crashes, up, rows, lastKind, lastRows, alertBase, unsure,
                   jobs, ambiguous, armed, apnsFailures, noted, owedVars, apnsVars, phoneVars,
                   rowSer, seenRead, told, dupNote, rangOff, bothOffSent>>

ApnsAcceptsOrphan(m) ==
    /\ m \in orphans
    /\ orphans' = orphans \ {m} /\ apnsQ' = Append(apnsQ, m)
    /\ UNCHANGED <<hostVars, pubVars, pushVars, phoneVars, ghostVars>>

ApnsNeverGetsOrphan(m) ==
    /\ m \in orphans
    /\ orphans' = orphans \ {m}
    /\ UNCHANGED <<hostVars, pubVars, pushVars, apnsQ, phoneVars, ghostVars>>

\* ---- iPhone: APNs hands over payloads in the order it accepted them. A card
\* payload for an ended card shows nothing; a notification always rings.
PhoneGetsPush ==
    /\ apnsQ # <<>>
    /\ LET m == Head(apnsQ)
           shown == m.kind = "note" \/ cardKind # "ended"
           rings == IF shown THEN m.alerts ELSE {}
           expected == IF cardKind = "agg" /\ m.kind = "update"
                       THEN Entering(cardRows, m.rows) ELSE {}
       IN /\ apnsQ' = Tail(apnsQ)
          /\ IF ~shown \/ m.kind = "note"
             THEN UNCHANGED phoneVars
             ELSE /\ cardKind' = IF m.kind = "end" THEN "ended" ELSE "agg"
                  /\ cardRows' = m.rows
                  /\ dupAlert' = (dupAlert \/ m.alerts \ expected # {})
                  /\ missedAlert' = (missedAlert \/
                         (expected \ m.alerts # {} /\ ~m.afterAmbiguous /\ ~m.quiet))
          /\ dupNote' = (dupNote \/ \E h \in rings : m.ser[h] <= told[h])
          /\ told' = [h \in Hosts |-> IF h \in rings /\ m.ser[h] > told[h] THEN m.ser[h] ELSE told[h]]
          /\ owe' = [h \in Hosts |-> IF h \in rings /\ owe[h] # 0 /\ m.ser[h] >= owe[h]
                                     THEN 0 ELSE owe[h]]
    /\ UNCHANGED <<hostVars, pubVars, pushVars, orphans, rowSer, seenRead, rangOff, bothOffSent>>

Quiescent ==
    /\ up /\ ~armed /\ ~SweepDue /\ queued = {} /\ jobs = {} /\ orphans = {} /\ apnsQ = <<>>
    /\ \A h \in Hosts : ~pending[h] /\ req[h] = "none"

Settled == Quiescent /\ UNCHANGED vars

Next ==
    \/ \E h \in Hosts : ThreadChanges(h) \/ ThreadTouches(h) \/ HostPublishes(h)
                        \/ HostGetsReply(h) \/ HostTimesOut(h)
                        \/ PushStoresPublish(h) \/ PushIsDown(h)
    \/ PushStartsDelivery
    \/ \E j \in jobs : ApnsAccepts(j) \/ ApnsRefuses(j) \/ ApnsTimesOut(j) \/ PushRecordsDelivery(j)
    \/ \E m \in orphans : ApnsAcceptsOrphan(m) \/ ApnsNeverGetsOrphan(m)
    \/ PushCrashes \/ PushRestarts \/ GraceExpires \/ IdleSweep \/ PhoneRegisters
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

\* With notifications on, once everything settles, every change of a thread into
\* ask or done that t3-push read has rung, as a card alert or a push notification,
\* except: the card's first update (no baseline), a send that a crash or an APNs
\* timeout left unknown, and a change replaced before a delivery read it.
NoMissedNotification == Quiescent => owe = NoSers

\* The phone never rings twice for one change of a thread's phase, on either channel.
NoDuplicateNotification == ~dupNote

\* After t3-push stores "notifications off", nothing it sends rings.
SilentWhenNotificationsOff == ~rangOff

\* Once everything settles with Live Activities off, the phone shows no card.
CardEndsWhenLiveActivitiesOff == Quiescent /\ ~laOn => cardKind = "ended"

\* With both switches off, t3-push sends nothing but a silent end of a leftover card.
OnlyEndWhenBothOff == ~bothOffSent
=============================================================================
