----------------------------- MODULE SuperThreads -----------------------------
(***************************************************************************)
(* Super threads (docs/internals/super-threads.md). A super thread S on    *)
(* environment E1 launches threads; each launch it makes through           *)
(* t3_thread_launch or create_threads appends the child to S's member      *)
(* list. A client derives one sidebar section per super thread from that   *)
(* list and the threads' settled state, and settling the header settles    *)
(* the group after a confirmation.                                         *)
(*                                                                         *)
(* Threads: S, the super thread on E1. L, a child S launches locally. R, a *)
(* child S launches in the linked environment E2. D, a delegate_task child *)
(* of S. O, an outside thread on E1 the super agent only messages. S2, a   *)
(* second super thread on E2 that launches nothing; it exists to give      *)
(* "a thread belongs to at most one group" something to break against.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxCrashes,     \* E1 server crashes (a launch handler in flight dies)
    MaxRetries,     \* launch retries by the agent, with the same clientRequestId
    MaxMessages,    \* messages to threads: each starts a run and unsettles the thread
    MaxOutages,     \* times E2 becomes unreachable from E1 and the client
    MaxCascades,    \* times the person settles the header
    WriteAheadLocal,         \* a local launch records the member before it dispatches thread.create
    GuardSettleByRun,        \* each cascade settle carries expectedLatestRunId from the confirmation
    LaunchOnlyMembership,    \* nothing but the super thread's own launch adds a member
    ExcludeDelegates,        \* delegate_task children never join
    SectionFromAnyUnsettled, \* a section shows while the header or any held member is unsettled
    SettledMembersLeaveSection, \* a settled member sits on the Settled shelf, not in the section
    HeaderLeavesShelf,       \* a settled super thread whose section shows is the header, not on the shelf
    UnsettleHeaderOnly       \* unsettling the super thread leaves its members as they are

Threads  == {"S", "L", "R", "D", "O", "S2"}
Children == {"L", "R"}                \* what S launches through t3_thread_launch
Active   == {"S", "L", "R", "D"}      \* threads whose runs the model plays out
Env(t)   == IF t \in {"R", "S2"} THEN "E2" ELSE "E1"
Phases   == {"idle", "working", "input"}   \* idle with a run behind it is done

VARIABLES
    exists,     \* the thread row exists on its environment
    settled,    \* settledOverride = "settled"
    phase,      \* the latest run's state
    run,        \* ordinal of the latest run
    members,    \* S's superThread.members (environment-qualified ids; env is fixed per thread here)
    members2,   \* S2's superThread.members
    lpc,        \* each launch call: none, step1, step2, failed, done, abandoned
    retries, crashes, msgs, outages, adopts, cascades,
    reach2,     \* E2 reachable from E1 and from the client
    cstate,     \* the client's settle cascade: idle, confirming, sending
    targets,    \* threads the cascade still has to settle
    seen,       \* latest run ordinal per thread when the person was shown the warning
    warned,     \* threads the warning listed (busy, waiting, or unreachable)
    badSettle,  \* ghost: the cascade settled a thread the person was not warned about
    headerTouched \* ghost: unsettling the header changed a member

vars == <<exists, settled, phase, run, members, members2, lpc, retries, crashes, msgs,
          outages, adopts, cascades, reach2, cstate, targets, seen, warned, badSettle,
          headerTouched>>

TypeOK ==
    /\ exists \in [Threads -> BOOLEAN]
    /\ settled \in [Threads -> BOOLEAN]
    /\ phase \in [Threads -> Phases]
    /\ members \subseteq Threads /\ members2 \subseteq Threads
    /\ lpc \in [Children -> {"none", "step1", "step2", "failed", "done", "abandoned"}]
    /\ cstate \in {"idle", "confirming", "sending"}
    /\ targets \subseteq Threads /\ warned \subseteq Threads

Init ==
    /\ exists = [t \in Threads |-> t \in {"S", "O", "S2"}]
    /\ settled = [t \in Threads |-> FALSE]
    /\ phase = [t \in Threads |-> "idle"]
    /\ run = [t \in Threads |-> 0]
    /\ members = {} /\ members2 = {}
    /\ lpc = [c \in Children |-> "none"]
    /\ retries = 0 /\ crashes = 0 /\ msgs = 0 /\ outages = 0 /\ adopts = 0 /\ cascades = 0
    /\ reach2 = TRUE
    /\ cstate = "idle" /\ targets = {} /\ seen = [t \in Threads |-> 0] /\ warned = {}
    /\ badSettle = FALSE /\ headerTouched = FALSE

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
Create(c) ==
    IF exists[c]
      THEN UNCHANGED <<exists, run, phase>>                   \* a replayed launch
      ELSE /\ exists' = [exists EXCEPT ![c] = TRUE]
           /\ run' = [run EXCEPT ![c] = 1]
           /\ phase' = [phase EXCEPT ![c] = "working"]

StartLaunch(c) ==
    /\ lpc[c] = "none"
    /\ lpc' = [lpc EXCEPT ![c] = "step1"]
    /\ UNCHANGED <<exists, settled, phase, run, members, members2, retries, crashes, msgs,
                   outages, adopts, cascades, reach2, cstate, targets, seen, warned,
                   badSettle, headerTouched>>

LocalStep1 ==
    /\ lpc["L"] = "step1"
    /\ IF WriteAheadLocal
         THEN /\ members' = members \cup {"L"} /\ UNCHANGED <<exists, run, phase>>
         ELSE /\ Create("L") /\ UNCHANGED members
    /\ lpc' = [lpc EXCEPT !["L"] = "step2"]
    /\ UNCHANGED <<settled, members2, retries, crashes, msgs, outages, adopts, cascades,
                   reach2, cstate, targets, seen, warned, badSettle, headerTouched>>

LocalStep2 ==
    /\ lpc["L"] = "step2"
    /\ IF WriteAheadLocal
         THEN /\ Create("L") /\ UNCHANGED members
         ELSE /\ members' = members \cup {"L"} /\ UNCHANGED <<exists, run, phase>>
    /\ lpc' = [lpc EXCEPT !["L"] = "done"]
    /\ UNCHANGED <<settled, members2, retries, crashes, msgs, outages, adopts, cascades,
                   reach2, cstate, targets, seen, warned, badSettle, headerTouched>>

\* The forwarded launch runs on E2; E1 learns R's id only from its result.
RemoteLaunch ==
    /\ lpc["R"] = "step1"
    /\ IF reach2
         THEN /\ Create("R") /\ lpc' = [lpc EXCEPT !["R"] = "step2"]
         ELSE /\ lpc' = [lpc EXCEPT !["R"] = "failed"] /\ UNCHANGED <<exists, run, phase>>
    /\ UNCHANGED <<settled, members, members2, retries, crashes, msgs, outages, adopts,
                   cascades, reach2, cstate, targets, seen, warned, badSettle, headerTouched>>

RemoteRecord ==
    /\ lpc["R"] = "step2"
    /\ members' = members \cup {"R"}
    /\ lpc' = [lpc EXCEPT !["R"] = "done"]
    /\ UNCHANGED <<exists, settled, phase, run, members2, retries, crashes, msgs, outages,
                   adopts, cascades, reach2, cstate, targets, seen, warned, badSettle,
                   headerTouched>>

\* E1 restarts: every launch handler in flight on it dies, and the agent's call fails.
CrashE1 ==
    /\ crashes < MaxCrashes
    /\ \E c \in Children : lpc[c] \in {"step1", "step2"}
    /\ crashes' = crashes + 1
    /\ lpc' = [c \in Children |-> IF lpc[c] \in {"step1", "step2"} THEN "failed" ELSE lpc[c]]
    /\ UNCHANGED <<exists, settled, phase, run, members, members2, retries, msgs, outages,
                   adopts, cascades, reach2, cstate, targets, seen, warned, badSettle,
                   headerTouched>>

Retry(c) ==
    /\ lpc[c] = "failed" /\ retries < MaxRetries
    /\ retries' = retries + 1
    /\ lpc' = [lpc EXCEPT ![c] = "step1"]
    /\ UNCHANGED <<exists, settled, phase, run, members, members2, crashes, msgs, outages,
                   adopts, cascades, reach2, cstate, targets, seen, warned, badSettle,
                   headerTouched>>

GiveUp(c) ==
    /\ lpc[c] = "failed"
    /\ lpc' = [lpc EXCEPT ![c] = "abandoned"]
    /\ UNCHANGED <<exists, settled, phase, run, members, members2, retries, crashes, msgs,
                   outages, adopts, cascades, reach2, cstate, targets, seen, warned,
                   badSettle, headerTouched>>

DelegateTask ==
    /\ ~exists["D"]
    /\ exists' = [exists EXCEPT !["D"] = TRUE]
    /\ run' = [run EXCEPT !["D"] = 1]
    /\ phase' = [phase EXCEPT !["D"] = "working"]
    /\ members' = IF ExcludeDelegates THEN members ELSE members \cup {"D"}
    /\ UNCHANGED <<settled, members2, lpc, retries, crashes, msgs, outages, adopts, cascades,
                   reach2, cstate, targets, seen, warned, badSettle, headerTouched>>

\* Only possible without LaunchOnlyMembership: an "add this thread" path.
Adopt ==
    /\ ~LaunchOnlyMembership /\ adopts < 1
    /\ adopts' = adopts + 1
    /\ \/ members' = members \cup {"O"} /\ UNCHANGED members2
       \/ exists["L"] /\ members2' = members2 \cup {"L"} /\ UNCHANGED members
    /\ UNCHANGED <<exists, settled, phase, run, lpc, retries, crashes, msgs, outages,
                   cascades, reach2, cstate, targets, seen, warned, badSettle, headerTouched>>

\* ---------------------------------------------------------------------------
\* Runs and settlement on the servers (Orchestrator dispatchMessage clears
\* settledOverride; ThreadSettlementService auto-settles idle threads).
\* ---------------------------------------------------------------------------
Message(t) ==
    /\ t \in Active /\ exists[t] /\ msgs < MaxMessages
    /\ msgs' = msgs + 1
    /\ run' = [run EXCEPT ![t] = @ + 1]
    /\ phase' = [phase EXCEPT ![t] = "working"]
    /\ settled' = [settled EXCEPT ![t] = FALSE]
    /\ UNCHANGED <<exists, members, members2, lpc, retries, crashes, outages, adopts,
                   cascades, reach2, cstate, targets, seen, warned, badSettle, headerTouched>>

Progress(t) ==
    /\ t \in Active /\ exists[t] /\ phase[t] # "idle"
    /\ phase' = [phase EXCEPT ![t] = IF @ = "input" THEN "working" ELSE "input"]
    /\ UNCHANGED <<exists, settled, run, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, cascades, reach2, cstate, targets, seen, warned,
                   badSettle, headerTouched>>

Finish(t) ==
    /\ t \in Active /\ exists[t] /\ phase[t] = "working"
    /\ phase' = [phase EXCEPT ![t] = "idle"]
    /\ UNCHANGED <<exists, settled, run, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, cascades, reach2, cstate, targets, seen, warned,
                   badSettle, headerTouched>>

AutoSettle(t) ==
    /\ t \in Active /\ exists[t] /\ phase[t] = "idle" /\ ~settled[t]
    /\ settled' = [settled EXCEPT ![t] = TRUE]
    /\ UNCHANGED <<exists, phase, run, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, cascades, reach2, cstate, targets, seen, warned,
                   badSettle, headerTouched>>

\* The person settles or unsettles one member row by hand.
ToggleMember(t) ==
    /\ t \in {"L", "R", "D"} /\ Held(t)
    /\ settled' = [settled EXCEPT ![t] = ~@]
    /\ UNCHANGED <<exists, phase, run, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, cascades, reach2, cstate, targets, seen, warned,
                   badSettle, headerTouched>>

UnsettleHeader ==
    /\ settled["S"]
    /\ settled' = [t \in Threads |->
                     IF t = "S" THEN FALSE
                     ELSE IF ~UnsettleHeaderOnly /\ t \in members THEN FALSE
                     ELSE settled[t]]
    /\ headerTouched' = (headerTouched \/ \E m \in members : settled'[m] # settled[m])
    /\ UNCHANGED <<exists, phase, run, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, cascades, reach2, cstate, targets, seen, warned, badSettle>>

Outage ==
    /\ \/ reach2 /\ outages < MaxOutages /\ outages' = outages + 1 /\ reach2' = FALSE
       \/ ~reach2 /\ reach2' = TRUE /\ UNCHANGED outages
    /\ UNCHANGED <<exists, settled, phase, run, members, members2, lpc, retries, crashes,
                   msgs, adopts, cascades, cstate, targets, seen, warned, badSettle,
                   headerTouched>>

\* ---------------------------------------------------------------------------
\* The client's settle cascade (useThreadActions().settleThread on a header).
\* ---------------------------------------------------------------------------
PlanSettle ==
    /\ cstate = "idle" /\ cascades < MaxCascades /\ Shown("S", members)
    /\ cascades' = cascades + 1
    /\ LET ts == {"S"} \cup {m \in members : Held(m) /\ ~settled[m]}
       IN /\ targets' = ts
          /\ warned' = {t \in ts : phase[t] # "idle"} \cup {m \in members : ~Held(m)}
    /\ seen' = run
    /\ cstate' = "confirming"
    /\ UNCHANGED <<exists, settled, phase, run, members, members2, lpc, retries, crashes,
                   msgs, outages, adopts, reach2, badSettle, headerTouched>>

Confirm ==
    /\ cstate = "confirming"
    /\ cstate' = "sending"
    /\ UNCHANGED <<exists, settled, phase, run, members, members2, lpc, retries, crashes,
                   msgs, outages, adopts, cascades, reach2, targets, seen, warned, badSettle,
                   headerTouched>>

\* The person cancels, or the client goes away mid-cascade.
StopCascade ==
    /\ cstate # "idle"
    /\ cstate' = "idle" /\ targets' = {}
    /\ UNCHANGED <<exists, settled, phase, run, members, members2, lpc, retries, crashes,
                   msgs, outages, adopts, cascades, reach2, seen, warned, badSettle,
                   headerTouched>>

SendSettle(t) ==
    /\ cstate = "sending" /\ t \in targets
    /\ targets' = targets \ {t}
    /\ cstate' = IF targets' = {} THEN "idle" ELSE "sending"
    /\ IF (Env(t) = "E2" /\ ~reach2) \/ (GuardSettleByRun /\ run[t] # seen[t])
         THEN UNCHANGED <<settled, badSettle>>                \* unreachable, or refused
         ELSE /\ settled' = [settled EXCEPT ![t] = TRUE]
              /\ badSettle' = (badSettle \/ run[t] # seen[t]
                                \/ (phase[t] # "idle" /\ t \notin warned))
    /\ UNCHANGED <<exists, phase, run, members, members2, lpc, retries, crashes, msgs,
                   outages, adopts, cascades, reach2, seen, warned, headerTouched>>

Next ==
    \/ \E c \in Children : StartLaunch(c) \/ Retry(c) \/ GiveUp(c)
    \/ LocalStep1 \/ LocalStep2 \/ RemoteLaunch \/ RemoteRecord \/ CrashE1
    \/ DelegateTask \/ Adopt
    \/ \E t \in Threads : Message(t) \/ Progress(t) \/ Finish(t) \/ AutoSettle(t)
                          \/ ToggleMember(t) \/ SendSettle(t)
    \/ UnsettleHeader \/ Outage \/ PlanSettle \/ Confirm \/ StopCascade

Spec == Init /\ [][Next]_vars

\* ---------------------------------------------------------------------------
\* Rules
\* ---------------------------------------------------------------------------
Quiescent == (\A c \in Children : lpc[c] \in {"none", "done", "abandoned"}) /\ cstate = "idle"

\* Every member of a super thread is a thread it launched with t3_thread_launch or create_threads.
MembersOnlyOwnLaunches == members \subseteq Children /\ members2 = {}

\* No thread is a member of two super threads.
AtMostOneGroup == members \cap members2 = {}

\* Settling the header never settles a thread the person was not warned about, or one that started
\* new work after the person confirmed.
NoUnwarnedSettle == ~badSettle

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

\* Once nothing is in flight, every thread S launched is a member. Exception: a launch in the linked
\* environment whose result E1 never recorded because E1 crashed and the agent did not retry.
EveryLaunchJoins ==
    Quiescent =>
      \A c \in Children : exists[c] => (c \in members \/ (c = "R" /\ lpc[c] = "abandoned"))

\* EveryLaunchJoins without its exception. Kept as an open finding: no design here records a
\* linked-environment launch that E1 crashed before recording, short of the child naming its parent.
EveryLaunchJoinsStrict ==
    Quiescent => \A c \in Children : exists[c] => c \in members
=============================================================================
