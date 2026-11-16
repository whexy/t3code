----------------------------- MODULE SuperThreads -----------------------------
(***************************************************************************)
(* Super threads (docs/internals/super-threads.md). A super thread S on    *)
(* environment E1 launches threads; each launch it makes through           *)
(* t3_thread_launch or create_threads appends the child to S's member      *)
(* list. A client derives one sidebar section per super thread from that   *)
(* list and the threads' settled state, and settling the header settles    *)
(* the group after a confirmation.                                         *)
(*                                                                         *)
(* Threads: S, the super thread on E1. L, a child S launches locally, and *)
(* L2, the thread a retry of that launch starts after an E1 crash (the     *)
(* launch id derives from the provider session, which a restart replaces). *)
(* R, a child S launches in the linked environment E2, and R2, the thread  *)
(* the agent's retry starts there after an E1 crash (E1 scopes the         *)
(* forwarded clientRequestId by that same provider session). D, a          *)
(* delegate_task child of S. O, an outside thread on E1 the super agent    *)
(* only messages.                                                          *)
(* S2, a second super thread on E2 that launches nothing; it exists to     *)
(* give "a thread belongs to at most one group" something to break against.*)
(*                                                                         *)
(* A member's run finishing or starting to wait for the person wakes S:    *)
(* the report waits in owed until E1 hears it (a remote one only while E2  *)
(* is reachable), then starts a run on an idle S, queues one behind a busy *)
(* S, or joins the wake still queued. Any settle of S cancels a queued wake.*)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxCrashes,     \* E1 server crashes (a launch handler in flight dies)
    MaxRetries,     \* launch retries by the agent, with the same clientRequestId
    MaxMessages,    \* messages to threads: each starts a run and unsettles the thread
    MaxOutages,     \* times E2 becomes unreachable from E1 and the client
    MaxCascades,    \* times the person settles the header
    MaxWakes,       \* member outcomes that report a wake to S
    WriteAheadLocal,         \* a local launch records the member before it dispatches thread.create
    LaunchOnlyMembership,    \* nothing but the super thread's own launch adds a member
    ExcludeDelegates,        \* delegate_task children never join
    SectionFromAnyUnsettled, \* a section shows while the header or any held member is unsettled
    SettledMembersLeaveSection, \* a settled member sits on the Settled shelf, not in the section
    HeaderLeavesShelf,       \* a settled super thread whose section shows is the header, not on the shelf
    UnsettleHeaderOnly,      \* unsettling the super thread leaves its members as they are
    ReplayRemoteLaunch,      \* a remote launch is written down before it goes; E1 replays it after a crash
    WakeSkipsSettled,        \* the wake command checks S's settled state under S's command lock
    FoldWakes                \* an outcome while a wake is queued joins it instead of queuing another

Threads  == {"S", "L", "L2", "R", "R2", "D", "O", "S2"}
Locals   == {"L", "L2"}               \* launched here: t3_thread_launch or create_threads
Remotes  == {"R", "R2"}               \* launched in E2 through a forwarded t3_thread_launch
Children == Locals \cup Remotes       \* what S launches through t3_thread_launch
Active   == {"S", "L", "L2", "R", "R2", "D"} \* threads whose runs the model plays out
Env(t)   == IF t \in {"R", "R2", "S2"} THEN "E2" ELSE "E1"
\* The thread an agent's retry starts after an E1 crash replaced its provider session.
Successor(c) == IF c = "L" THEN "L2" ELSE "R2"
Phases   == {"idle", "working", "input"}   \* idle with a run behind it is done

VARIABLES
    exists,     \* the thread row exists on its environment
    settled,    \* settledOverride = "settled"
    phase,      \* the latest run's state
    members,    \* S's superThread.members (environment-qualified ids; env is fixed per thread here)
    members2,   \* S2's superThread.members
    lpc,        \* each launch call: none, step1, step2, failed, crashed, done, abandoned, replaced
    pending,    \* remote launches written down on S and not yet answered (pendingLaunches)
    rpc,        \* E1's replay of each pending launch: none, or record once E2 answered
    retries, crashes, msgs, outages, adopts, cascades,
    reach2,     \* E2 reachable from E1 and from the client
    cstate,     \* the client's settle cascade: idle, confirming, sending
    targets,    \* threads the cascade still has to settle
    headerTouched, \* ghost: unsettling the header changed a member
    owed,       \* members whose outcome E1 has yet to turn into a wake of S
    queuedWake, \* wake runs queued on S behind its current run
    wakes,      \* member outcomes reported so far
    badWake     \* ghost: a member's outcome reopened a settled S or started work on it

vars == <<exists, settled, phase, members, members2, lpc, pending, rpc, retries, crashes, msgs,
          outages, adopts, cascades, reach2, cstate, targets,
          headerTouched, owed, queuedWake, wakes, badWake>>

TypeOK ==
    /\ exists \in [Threads -> BOOLEAN]
    /\ settled \in [Threads -> BOOLEAN]
    /\ phase \in [Threads -> Phases]
    /\ members \subseteq Threads /\ members2 \subseteq Threads
    /\ lpc \in [Children -> {"none", "step1", "step2", "failed", "crashed", "done", "abandoned",
                              "replaced"}]
    /\ pending \subseteq Remotes /\ rpc \in [Remotes -> {"none", "record"}]
    /\ cstate \in {"idle", "confirming", "sending"}
    /\ targets \subseteq Threads
    /\ owed \subseteq Threads /\ queuedWake \in Nat /\ wakes \in Nat

Init ==
    /\ exists = [t \in Threads |-> t \in {"S", "O", "S2"}]
    /\ settled = [t \in Threads |-> FALSE]
    \* A super thread starts with its first message (draft send or the bridge's task).
    /\ phase = [t \in Threads |-> IF t = "S" THEN "working" ELSE "idle"]
    /\ members = {} /\ members2 = {}
    /\ lpc = [c \in Children |-> "none"]
    /\ pending = {} /\ rpc = [c \in Remotes |-> "none"]
    /\ retries = 0 /\ crashes = 0 /\ msgs = 0 /\ outages = 0 /\ adopts = 0 /\ cascades = 0
    /\ reach2 = TRUE
    /\ cstate = "idle" /\ targets = {}
    /\ headerTouched = FALSE
    /\ owed = {} /\ queuedWake = 0 /\ wakes = 0 /\ badWake = FALSE

\* ---------------------------------------------------------------------------
\* What the client can see, and where it puts each thread.
\* ---------------------------------------------------------------------------
Held(t) == exists[t] /\ (Env(t) = "E1" \/ reach2)

Shown(s, ms) ==
    /\ Held(s)
    /\ IF SectionFromAnyUnsettled
         THEN ~settled[s] \/ \E m \in ms : Held(m) /\ ~settled[m]
         ELSE ~settled[s]

\* Every place a held thread appears: a section header, a section row, the
\* Settled shelf, or the ordinary sections (Pinned, Active, Working).
Places(t) ==
    LET groups == {<<"S", members>>, <<"S2", members2>>}
        header == {<<"header", g[1]>> : g \in {g \in groups : g[1] = t /\ Shown(g[1], g[2])}}
        rows   == {<<"section", g[1]>> :
                     g \in {g \in groups : t \in g[2] /\ Shown(g[1], g[2])
                                           /\ (~settled[t] \/ ~SettledMembersLeaveSection)}}
        shelf  == IF settled[t] /\ ~(HeaderLeavesShelf /\ header # {})
                    THEN {<<"settled", "shelf">>} ELSE {}
        normal == IF ~settled[t] /\ header = {} /\ rows = {}
                    THEN {<<"normal", "list">>} ELSE {}
    IN header \cup rows \cup shelf \cup normal

\* ---------------------------------------------------------------------------
\* Launches (apps/server/src/mcp/toolkits/project/handlers.ts t3_thread_launch,
\* McpToolAccess.afterForwarding for a forwarded launch, delegate_task).
\* ---------------------------------------------------------------------------
\* A launch may carry no first message (t3_thread_launch without message, create_threads without
\* prompt): the thread then exists with no run.
Create(c) ==
    IF exists[c]
      THEN UNCHANGED <<exists, phase>>                        \* a replayed launch
      ELSE /\ exists' = [exists EXCEPT ![c] = TRUE]
           /\ \/ phase' = [phase EXCEPT ![c] = "working"]
              \/ UNCHANGED phase

\* Everything the cascade and the client track, and the member wakes, for actions that leave it alone.
wvars == <<owed, queuedWake, wakes, badWake>>
cvars == <<cascades, cstate, targets, headerTouched, wvars>>
\* E1's record of remote launches, for actions that leave it alone.
rvars == <<pending, rpc>>

StartLaunch(c) ==
    /\ c \in {"L", "R"} /\ lpc[c] = "none"
    /\ lpc' = [lpc EXCEPT ![c] = "step1"]
    /\ UNCHANGED <<exists, settled, phase, members, members2, retries, crashes, msgs,
                   outages, adopts, reach2>> /\ UNCHANGED cvars /\ UNCHANGED rvars

LocalStep1(c) ==
    /\ c \in Locals /\ lpc[c] = "step1"
    /\ IF WriteAheadLocal
         THEN /\ members' = members \cup {c} /\ UNCHANGED <<exists, phase>>
         ELSE /\ Create(c) /\ UNCHANGED members
    /\ lpc' = [lpc EXCEPT ![c] = "step2"]
    /\ UNCHANGED <<settled, members2, retries, crashes, msgs, outages, adopts, reach2>>
    /\ UNCHANGED cvars /\ UNCHANGED rvars

LocalStep2(c) ==
    /\ c \in Locals /\ lpc[c] = "step2"
    /\ IF WriteAheadLocal
         THEN /\ Create(c) /\ UNCHANGED members
         ELSE /\ members' = members \cup {c} /\ UNCHANGED <<exists, phase>>
    /\ lpc' = [lpc EXCEPT ![c] = "done"]
    /\ UNCHANGED <<settled, members2, retries, crashes, msgs, outages, adopts, reach2>>
    /\ UNCHANGED cvars /\ UNCHANGED rvars

\* With ReplayRemoteLaunch, S writes the launch down before it forwards it.
RemotePending(c) ==
    /\ ReplayRemoteLaunch /\ c \in Remotes /\ lpc[c] = "step1" /\ c \notin pending
    /\ pending' = pending \cup {c}
    /\ UNCHANGED <<exists, settled, phase, members, members2, lpc, rpc, retries, crashes,
                   msgs, outages, adopts, reach2>> /\ UNCHANGED cvars

\* The forwarded launch runs on E2; E1 learns its id only from the result. A call that fails may
\* still have made the thread there (its answer was lost), so its pending launch stays.
RemoteLaunch(c) ==
    /\ c \in Remotes /\ lpc[c] = "step1" /\ (ReplayRemoteLaunch => c \in pending)
    /\ IF reach2
         THEN /\ Create(c) /\ lpc' = [lpc EXCEPT ![c] = "step2"]
         ELSE /\ lpc' = [lpc EXCEPT ![c] = "failed"]
              /\ \/ Create(c)
                 \/ UNCHANGED <<exists, phase>>
    /\ UNCHANGED <<settled, members, members2, pending, rpc, retries, crashes, msgs, outages,
                   adopts, reach2>>
    /\ UNCHANGED cvars

\* recordForwardedLaunch: the member and the end of the pending launch commit together.
RemoteRecord(c) ==
    /\ c \in Remotes /\ lpc[c] = "step2"
    /\ members' = members \cup {c}
    /\ pending' = pending \ {c}
    /\ lpc' = [lpc EXCEPT ![c] = "done"]
    /\ UNCHANGED <<exists, settled, phase, members2, rpc, retries, crashes, msgs, outages,
                   adopts, reach2>> /\ UNCHANGED cvars

\* After a restart E1 replays each pending launch whose handler is gone, with the same scoped
\* request id: E2 answers with the thread it already created, or creates it now. While E2 is
\* unreachable the replay waits. E2 may refuse a launch it never accepted, which ends it. The code
\* replays only at startup; the model lets it run at any time, a superset.
ReplayLaunch(c) ==
    /\ c \in pending /\ rpc[c] = "none" /\ lpc[c] \notin {"step1", "step2"} /\ reach2
    /\ \/ Create(c) /\ rpc' = [rpc EXCEPT ![c] = "record"] /\ UNCHANGED pending
       \/ ~exists[c] /\ pending' = pending \ {c} /\ UNCHANGED <<exists, phase, rpc>>
    /\ UNCHANGED <<settled, members, members2, lpc, retries, crashes, msgs, outages, adopts,
                   reach2>> /\ UNCHANGED cvars

ReplayRecord(c) ==
    /\ rpc[c] = "record"
    /\ members' = members \cup {c}
    /\ pending' = pending \ {c}
    /\ rpc' = [rpc EXCEPT ![c] = "none"]
    /\ UNCHANGED <<exists, settled, phase, members2, lpc, retries, crashes, msgs, outages,
                   adopts, reach2>> /\ UNCHANGED cvars

\* E1 restarts: every launch handler and replay in flight on it dies, and the agent's call fails.
CrashE1 ==
    /\ crashes < MaxCrashes
    /\ \/ \E c \in Children : lpc[c] \in {"step1", "step2"}
       \/ \E c \in Remotes : rpc[c] # "none"
    /\ crashes' = crashes + 1
    /\ lpc' = [c \in Children |-> IF lpc[c] \in {"step1", "step2"} THEN "crashed" ELSE lpc[c]]
    /\ rpc' = [c \in Remotes |-> "none"]
    /\ UNCHANGED <<exists, settled, phase, members, members2, pending, retries, msgs,
                   outages, adopts, reach2>> /\ UNCHANGED cvars

\* A retry with the same clientRequestId. After an E2 outage the agent's provider session is the
\* same, so E2 replays the same launch. After an E1 crash the resumed agent has a new provider
\* session, which scopes both a local launch id and a forwarded request id, so the retry is a new
\* thread: L2 or R2.
Retry(c) ==
    /\ retries < MaxRetries
    /\ retries' = retries + 1
    /\ \/ /\ lpc[c] = "failed"
          /\ lpc' = [lpc EXCEPT ![c] = "step1"]
       \/ /\ lpc[c] = "crashed" /\ c \in {"L", "R"} /\ lpc[Successor(c)] = "none"
          /\ lpc' = [lpc EXCEPT ![c] = "replaced", ![Successor(c)] = "step1"]
    /\ UNCHANGED <<exists, settled, phase, members, members2, crashes, msgs, outages,
                   adopts, reach2>> /\ UNCHANGED cvars /\ UNCHANGED rvars

GiveUp(c) ==
    /\ lpc[c] \in {"failed", "crashed"}
    /\ lpc' = [lpc EXCEPT ![c] = "abandoned"]
    /\ UNCHANGED <<exists, settled, phase, members, members2, retries, crashes, msgs,
                   outages, adopts, reach2>> /\ UNCHANGED cvars /\ UNCHANGED rvars

DelegateTask ==
    /\ ~exists["D"]
    /\ exists' = [exists EXCEPT !["D"] = TRUE]
    /\ phase' = [phase EXCEPT !["D"] = "working"]
    /\ members' = IF ExcludeDelegates THEN members ELSE members \cup {"D"}
    /\ UNCHANGED <<settled, members2, lpc, retries, crashes, msgs, outages, adopts, reach2>>
    /\ UNCHANGED cvars
    /\ UNCHANGED rvars

\* Only possible without LaunchOnlyMembership: an "add this thread" path.
Adopt ==
    /\ ~LaunchOnlyMembership /\ adopts < 1
    /\ adopts' = adopts + 1
    /\ \/ members' = members \cup {"O"} /\ UNCHANGED members2
       \/ exists["L"] /\ members2' = members2 \cup {"L"} /\ UNCHANGED members
    /\ UNCHANGED <<exists, settled, phase, lpc, retries, crashes, msgs, outages, reach2>>
    /\ UNCHANGED cvars
    /\ UNCHANGED rvars

\* ---------------------------------------------------------------------------
\* Runs and settlement on the servers (Orchestrator dispatchMessage clears
\* settledOverride; ThreadSettlementService auto-settles idle threads).
\* ---------------------------------------------------------------------------
Message(t) ==
    /\ t \in Active /\ exists[t] /\ msgs < MaxMessages
    /\ msgs' = msgs + 1
    /\ phase' = [phase EXCEPT ![t] = "working"]
    /\ settled' = [settled EXCEPT ![t] = FALSE]
    /\ UNCHANGED <<exists, members, members2, lpc, retries, crashes, outages, adopts, reach2>>
    /\ UNCHANGED cvars
    /\ UNCHANGED rvars

\* A member's run starting to wait for the person, or finishing, reports a wake of S
\* (SuperThreadMemberWatch: its event here, or its follower there).
Report(t) ==
    IF t \in members /\ wakes < MaxWakes
      THEN /\ owed' = owed \cup {t} /\ wakes' = wakes + 1
      ELSE UNCHANGED <<owed, wakes>>

Progress(t) ==
    /\ t \in Active /\ exists[t] /\ phase[t] # "idle"
    /\ phase' = [phase EXCEPT ![t] = IF @ = "input" THEN "working" ELSE "input"]
    /\ IF phase[t] = "working" THEN Report(t) ELSE UNCHANGED <<owed, wakes>>
    /\ UNCHANGED <<exists, settled, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, reach2, queuedWake, badWake>>
    /\ UNCHANGED <<cascades, cstate, targets, headerTouched>>
    /\ UNCHANGED rvars

Finish(t) ==
    /\ t \in Active /\ exists[t] /\ phase[t] = "working"
    /\ phase' = [phase EXCEPT ![t] = "idle"]
    /\ Report(t)
    /\ UNCHANGED <<exists, settled, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, reach2, queuedWake, badWake>>
    /\ UNCHANGED <<cascades, cstate, targets, headerTouched>>
    /\ UNCHANGED rvars

\* Settling S, by hand or automatically, cancels its queued automatic runs (thread.settle).
AutoSettle(t) ==
    /\ t \in Active /\ exists[t] /\ phase[t] = "idle" /\ ~settled[t]
    /\ settled' = [settled EXCEPT ![t] = TRUE]
    /\ queuedWake' = IF t = "S" THEN 0 ELSE queuedWake
    /\ UNCHANGED <<exists, phase, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, reach2, owed, wakes, badWake>>
    /\ UNCHANGED <<cascades, cstate, targets, headerTouched>>
    /\ UNCHANGED rvars

\* E1 turns a reported outcome into the super_thread.member.wake command, which the orchestrator
\* decides under S's lock: nothing on a settled S, a line added to a queued wake, or a new wake
\* that dispatchMessage starts on an idle S or queues behind a busy one.
Deliver(m) ==
    /\ m \in owed /\ (Env(m) = "E1" \/ reach2)
    /\ owed' = owed \ {m}
    /\ IF settled["S"] /\ WakeSkipsSettled
         THEN UNCHANGED <<settled, phase, queuedWake, badWake>>
       ELSE IF queuedWake > 0 /\ FoldWakes
         THEN UNCHANGED <<settled, phase, queuedWake, badWake>>
       ELSE /\ settled' = [settled EXCEPT !["S"] = FALSE]
            /\ badWake' = (badWake \/ settled["S"])
            /\ IF phase["S"] = "idle" /\ queuedWake = 0
                 THEN /\ phase' = [phase EXCEPT !["S"] = "working"] /\ UNCHANGED queuedWake
                 ELSE /\ queuedWake' = queuedWake + 1 /\ UNCHANGED phase
    /\ UNCHANGED <<exists, members, members2, lpc, retries, crashes, msgs, outages, adopts,
                   reach2, wakes>>
    /\ UNCHANGED <<cascades, cstate, targets, headerTouched>>
    /\ UNCHANGED rvars

\* S's run ends and its next queued run starts.
StartQueued ==
    /\ queuedWake > 0 /\ phase["S"] = "idle"
    /\ queuedWake' = queuedWake - 1
    /\ phase' = [phase EXCEPT !["S"] = "working"]
    /\ badWake' = (badWake \/ settled["S"])
    /\ UNCHANGED <<exists, settled, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, reach2, owed, wakes>>
    /\ UNCHANGED <<cascades, cstate, targets, headerTouched>>
    /\ UNCHANGED rvars

\* The person settles or unsettles one member row by hand.
ToggleMember(t) ==
    /\ t \in {"L", "L2", "R", "R2", "D"} /\ Held(t)
    /\ settled' = [settled EXCEPT ![t] = ~@]
    /\ UNCHANGED <<exists, phase, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, reach2>> /\ UNCHANGED cvars
    /\ UNCHANGED rvars

UnsettleHeader ==
    /\ settled["S"]
    /\ settled' = [t \in Threads |->
                     IF t = "S" THEN FALSE
                     ELSE IF ~UnsettleHeaderOnly /\ t \in members THEN FALSE
                     ELSE settled[t]]
    /\ headerTouched' = (headerTouched \/ \E m \in members : settled'[m] # settled[m])
    /\ UNCHANGED <<exists, phase, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, reach2, cascades, cstate, targets>>
    /\ UNCHANGED rvars
    /\ UNCHANGED wvars

Outage ==
    /\ \/ reach2 /\ outages < MaxOutages /\ outages' = outages + 1 /\ reach2' = FALSE
       \/ ~reach2 /\ reach2' = TRUE /\ UNCHANGED outages
    /\ UNCHANGED <<exists, settled, phase, members, members2, lpc, retries, crashes,
                   msgs, adopts>> /\ UNCHANGED cvars
    /\ UNCHANGED rvars

\* ---------------------------------------------------------------------------
\* The client's settle cascade: planSuperThreadSettle when the person presses
\* Settle on the header, the confirmation, then useThreadActions().settleThread
\* sends the header and each planned member.
\* ---------------------------------------------------------------------------
PlanSettle ==
    /\ cstate = "idle" /\ cascades < MaxCascades /\ Shown("S", members)
    /\ cascades' = cascades + 1
    /\ LET planned == {m \in members : Held(m) /\ ~settled[m]}
       IN targets' = {"S"} \cup planned
    /\ cstate' = "confirming"
    /\ UNCHANGED <<exists, settled, phase, members, members2, lpc, retries, crashes,
                   msgs, outages, adopts, reach2, headerTouched>>
    /\ UNCHANGED rvars
    /\ UNCHANGED wvars

Confirm ==
    /\ cstate = "confirming"
    /\ cstate' = "sending"
    /\ UNCHANGED <<exists, settled, phase, members, members2, lpc, retries, crashes,
                   msgs, outages, adopts, cascades, reach2, targets,
                   headerTouched>>
    /\ UNCHANGED rvars
    /\ UNCHANGED wvars

\* The person cancels, or the client goes away mid-cascade.
StopCascade ==
    /\ cstate # "idle"
    /\ cstate' = "idle" /\ targets' = {}
    /\ UNCHANGED <<exists, settled, phase, members, members2, lpc, retries, crashes,
                   msgs, outages, adopts, cascades, reach2,
                   headerTouched>>
    /\ UNCHANGED rvars
    /\ UNCHANGED wvars

\* Each settle is the thread.settle a swipe on that one thread sends, with nothing added. The model
\* lets it settle a busy thread too, a superset of the server, which refuses one.
SendSettle(t) ==
    /\ cstate = "sending" /\ t \in targets
    /\ targets' = targets \ {t}
    /\ cstate' = IF targets' = {} THEN "idle" ELSE "sending"
    /\ IF Env(t) = "E2" /\ ~reach2
         THEN UNCHANGED <<settled, queuedWake>>
         ELSE /\ settled' = [settled EXCEPT ![t] = TRUE]
              /\ queuedWake' = IF t = "S" THEN 0 ELSE queuedWake
    /\ UNCHANGED <<exists, phase, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, cascades, reach2, headerTouched,
                   owed, wakes, badWake>>
    /\ UNCHANGED rvars

Next ==
    \/ \E c \in Children : StartLaunch(c) \/ Retry(c) \/ GiveUp(c)
                           \/ LocalStep1(c) \/ LocalStep2(c)
    \/ \E c \in Remotes : RemotePending(c) \/ RemoteLaunch(c) \/ RemoteRecord(c)
                          \/ ReplayLaunch(c) \/ ReplayRecord(c)
    \/ CrashE1
    \/ DelegateTask \/ Adopt
    \/ \E t \in Threads : Message(t) \/ Progress(t) \/ Finish(t) \/ AutoSettle(t)
                          \/ ToggleMember(t) \/ SendSettle(t)
    \/ UnsettleHeader \/ Outage \/ PlanSettle \/ Confirm \/ StopCascade
    \/ \E m \in Threads : Deliver(m)
    \/ StartQueued

Spec == Init /\ [][Next]_vars

\* ---------------------------------------------------------------------------
\* Rules
\* ---------------------------------------------------------------------------
Quiescent ==
    /\ \A c \in Children : lpc[c] \in {"none", "done", "abandoned", "replaced"}
    /\ pending = {}
    /\ cstate = "idle"

\* Every member of a super thread is a thread it launched with t3_thread_launch or create_threads.
MembersOnlyOwnLaunches == members \subseteq Children /\ members2 = {}

\* No thread is a member of two super threads.
AtMostOneGroup == members \cap members2 = {}

\* For a client that reaches both environments, an unsettled member is always in its shown section.
UnsettledMemberStaysVisible ==
    reach2 =>
      \A m \in members :
        (Held(m) /\ ~settled[m]) =>
          (<<"section", "S">> \in Places(m) /\ <<"header", "S">> \in Places("S"))

\* The client puts every thread it holds in exactly one place.
EachThreadPlacedOnce == \A t \in Threads : Held(t) => Cardinality(Places(t)) = 1

\* Unsettling the super thread never changes a member.
HeaderUnsettleKeepsMembers == ~headerTouched

\* A member's outcome never reopens a settled super thread or starts work on it; it shows in the
\* sidebar instead.
WakeNeverReopens == ~badWake

\* Outcomes that arrive while S is busy reach it together: at most one wake waits in its queue.
OneQueuedWake == queuedWake <= 1

\* Once nothing is in flight, every thread S launched is a member, including a launch in the linked
\* environment that E1 crashed before recording.
EveryLaunchJoins ==
    Quiescent => \A c \in Children : exists[c] => c \in members
=============================================================================
