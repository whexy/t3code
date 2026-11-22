----------------------------- MODULE OpenInRex -----------------------------
(***************************************************************************)
(* "Open in Rex": the session lifecycle of one worktree on one host.      *)
(* Server: apps/server/src/rex/RexSessions.ts; client: RexOpenInItem.tsx  *)
(* and apps/desktop/src/rex/select.ts. The verify skill maps every action *)
(* to its function.                                                        *)
(*                                                                         *)
(* A click r on Mac MacOf(r) asks the T3 server for the worktree's Rex    *)
(* session. The server keeps its own persisted record (worktree ->        *)
(* session id, state), because Rex sessions record no folder. It reuses   *)
(* the recorded session after `rex ls` shows it alive, or runs `rex new`  *)
(* and records the new session as pending with a lease. The Mac runs      *)
(* `session.select` and reports confirm or abandon. When no click holds a  *)
(* pending session any more, the server kills it unless the host has a    *)
(* sign it was opened: a confirm, or an app seen owning its size.          *)
(*                                                                         *)
(* Each Mac has two links that drop and come back on their own: its Rex   *)
(* app's link to the host, and its T3 client's link to the T3 server.     *)
(* Size ownership as measured on mudd (2026-11-18): an app that selects a  *)
(* session claims its block size, unless nobody is at the Mac; apps also  *)
(* join the block's `desired` list unasked but never own it that way.     *)
(* When the owner disconnects, ownership passes to a connected app in     *)
(* `desired` that shows the session, else to nobody; a returning app      *)
(* claims the size of the session it shows again.                         *)
(*                                                                         *)
(* A Mac that goes offline before the host has any sign the session was   *)
(* opened (no confirm, no size owner seen) has left a dangling session,    *)
(* whatever the reason: network, sleep, a closed lid. Cleaning it up is    *)
(* the intended behavior, not a bug. Once a confirm or a latched owner     *)
(* exists, the session is the user's and must never be killed.             *)
(*                                                                         *)
(* Time is not modelled as a clock. A lease ends only after the window of *)
(* the click it covers has closed: the client is done, its select (even   *)
(* one the client gave up on) has landed or been dropped, and a connected  *)
(* app has taken the size. MaxEarlyDrops bounds Rex drops that come       *)
(* before the server's poll could see the app own the size (within about  *)
(* a second of a select). Overrun is the fault where the window outlasts  *)
(* the lease.                                                              *)
(*                                                                         *)
(* Session ids: the session `rex new` makes for click r has id r, so ids   *)
(* are 1..NumClicks and 0 means none.                                      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  NumClicks,
  \* Fault budgets.
  MaxLoss,        \* messages lost on a link that stays up
  MaxEnds,        \* sessions closed in Rex by the user, or whose shell exits
  MaxRestarts,    \* T3 server restarts
  MaxOverruns,    \* clicks whose Mac-side work outlasts their lease
  MaxHand,        \* the user selecting a session by hand in a Rex app
  MaxInconclusive, \* selects that end without an answer the client can trust (the app may still act)
  MaxCreateFails, \* `rex new` calls that fail, having made the session or not
  MaxDrops,       \* link drops (Rex or T3, any Mac); early ones count here too
  MaxEarlyDrops,  \* Rex drops before a poll could see the app own the size
  MaxUnattended,  \* selects that succeed without the app claiming the size (nobody at the Mac)
  MaxWatches,     \* apps joining a session's `desired` list unasked (matters only once an owner disconnects)
  \* Design choices. FALSE everywhere is the design as approved.
  Holders,              \* reuse of a pending session joins it with its own lease; abandon and expiry end only that click's hold
  TakeoverCheck,        \* before killing, read the block's size owner; an app owning it counts as confirmed
  AbandonOnlyOnFailure, \* an inconclusive select (timed out, or "not found") reports nothing; only a definite failure abandons
  ClientDeadline,       \* the client never starts a select it cannot finish inside the lease
  WorktreeLock,         \* the server serializes check, create, reuse, reports and kill per worktree
  RestartRearm,         \* after a restart, pending sessions get a fresh lease instead of an immediate kill
  WriteAheadCreate,     \* persist the intent (label t3-<click>) before `rex new`; a failed create or startup reaps the labelled session
  OwnerLatch,           \* the server polls a pending session's size owner; an owner seen once counts at reap
  LatchPersisted,       \* the latch is part of the persisted record, so a restart keeps it
  \* Rex behavior the design relies on (measured on mudd, 2026-11-18). TRUE is
  \* what Rex does; check.sh flips each to show which rule rests on it.
  HandOff,              \* an owner that disconnects hands the size to an app in `desired` that shows the session
  UnaskedNeverOwns      \* an app in `desired` that does not show the session is never handed the size

Reqs == 1..NumClicks
Sids == Reqs
NoSid == 0
Macs == {"A", "B"}
MacOf(r) == IF r % 2 = 1 THEN "A" ELSE "B"
Reaper == NumClicks + 1   \* lock owner while the server reaps

VARIABLES
  \* Client (T3 desktop app) per click
  cl,        \* "idle" | "waiting" | "selecting" | "done"
  got,       \* session id the client received
  inWindow,  \* the click's Mac-side work may still touch Rex or T3
  late,      \* a select the client timed out on may still land in the app
  \* T3 server
  srv,       \* per click: "idle" | "check" | "reuse" | "intent" | "create" | "record" | "done" | "lost"
  seen,      \* per click: the session the check found alive
  lock,      \* 0 free, r a click, Reaper the reaper (only with WorktreeLock)
  rec,       \* persisted record: [st, sid, holders, saw]; saw: a poll saw an app own the size
  reapCheck, \* in-memory: the reaper holds the lock and has yet to read the session
  reaping,   \* in-memory: session the reaper decided to kill (0: none)
  booting,   \* restarted, startup cleanup not yet run
  \* Each Mac
  rexUp,     \* its Rex app is connected to the host
  t3Up,      \* its T3 client is connected to the T3 server
  shows,     \* session its app shows (0: none)
  wants,     \* its app has yet to take the shown session's size
  fresh,     \* its app showed a session too recently for a poll to have seen it own the size
  \* Rex sessions on the host, and history
  alive, created, killed, confirmed,
  viaT3,     \* Macs that selected the session through Open in Rex
  byHand,    \* Macs whose user selected the session by hand
  owner,     \* the Mac whose app owns the session's block size, or "none" (nobody, or the creating client)
  desired,   \* Macs whose apps are in the block's `desired` list
  \* Ghosts: what the host could know, for the scoped rules
  signal,    \* a confirm reached the server, or an app owned the size through a poll while the server was up
  dark,      \* Macs that opened the session and went offline while it had no signal
  killRace,  \* the kill ran while a hand-selecting app's request for the size was in flight or reached the host after the reaper checked
  killSig,   \* the kill ran although the session had a signal
  unattended, \* Macs whose select of the session succeeded without claiming the size
  falseSign, \* an app that never opened the session came to own its size
  \* Network and faults
  net, faults

vars == <<cl, got, inWindow, late, srv, seen, lock, rec, reapCheck, reaping, booting,
          rexUp, t3Up, shows, wants, fresh,
          alive, created, killed, confirmed, viaT3, byHand, owner, desired,
          signal, dark, killRace, killSig, unattended, falseSign,
          net, faults>>

Msg(k, r, s) == [k |-> k, r |-> r, s |-> s]
Messages == [k : {"req", "resp", "confirm", "abandon"}, r : Reqs, s : Sids \cup {NoSid}]
NoRec == [st |-> "none", sid |-> NoSid, holders |-> {}, saw |-> FALSE]
Pending(s, h) == [st |-> "pending", sid |-> s, holders |-> h, saw |-> FALSE]
Confirmed(s) == [st |-> "confirmed", sid |-> s, holders |-> {}, saw |-> FALSE]

TypeOK ==
  /\ cl \in [Reqs -> {"idle", "waiting", "selecting", "done"}]
  /\ got \in [Reqs -> Sids \cup {NoSid}]
  /\ inWindow \in [Reqs -> BOOLEAN] /\ late \in [Reqs -> BOOLEAN]
  /\ srv \in [Reqs -> {"idle", "check", "reuse", "intent", "create", "record", "done", "lost"}]
  /\ seen \in [Reqs -> Sids \cup {NoSid}]
  /\ lock \in 0..Reaper
  /\ rec \in [st : {"none", "intent", "pending", "confirmed"}, sid : Sids \cup {NoSid},
              holders : SUBSET Reqs, saw : BOOLEAN]
  /\ reapCheck \in BOOLEAN
  /\ reaping \in Sids \cup {NoSid}
  /\ booting \in BOOLEAN
  /\ rexUp \in [Macs -> BOOLEAN] /\ t3Up \in [Macs -> BOOLEAN]
  /\ shows \in [Macs -> Sids \cup {NoSid}] /\ wants \in [Macs -> BOOLEAN] /\ fresh \in [Macs -> BOOLEAN]
  /\ alive \in [Sids -> BOOLEAN] /\ created \in [Sids -> BOOLEAN]
  /\ killed \in [Sids -> BOOLEAN] /\ confirmed \in [Sids -> BOOLEAN]
  /\ viaT3 \in [Sids -> SUBSET Macs] /\ byHand \in [Sids -> SUBSET Macs]
  /\ owner \in [Sids -> Macs \cup {"none"}] /\ desired \in [Sids -> SUBSET Macs]
  /\ unattended \in [Sids -> SUBSET Macs] /\ falseSign \in [Sids -> BOOLEAN]
  /\ signal \in [Sids -> BOOLEAN] /\ dark \in [Sids -> SUBSET Macs]
  /\ killRace \in [Sids -> BOOLEAN] /\ killSig \in [Sids -> BOOLEAN]
  /\ net \subseteq Messages

Init ==
  /\ cl = [r \in Reqs |-> "idle"]
  /\ got = [r \in Reqs |-> NoSid]
  /\ inWindow = [r \in Reqs |-> FALSE]
  /\ late = [r \in Reqs |-> FALSE]
  /\ srv = [r \in Reqs |-> "idle"]
  /\ seen = [r \in Reqs |-> NoSid]
  /\ lock = 0
  /\ rec = NoRec
  /\ reapCheck = FALSE
  /\ reaping = NoSid
  /\ booting = FALSE
  /\ rexUp = [m \in Macs |-> TRUE]
  /\ t3Up = [m \in Macs |-> TRUE]
  /\ shows = [m \in Macs |-> NoSid]
  /\ wants = [m \in Macs |-> FALSE]
  /\ fresh = [m \in Macs |-> FALSE]
  /\ alive = [s \in Sids |-> FALSE]
  /\ created = [s \in Sids |-> FALSE]
  /\ killed = [s \in Sids |-> FALSE]
  /\ confirmed = [s \in Sids |-> FALSE]
  /\ viaT3 = [s \in Sids |-> {}]
  /\ byHand = [s \in Sids |-> {}]
  /\ owner = [s \in Sids |-> "none"]
  /\ desired = [s \in Sids |-> {}]
  /\ unattended = [s \in Sids |-> {}]
  /\ falseSign = [s \in Sids |-> FALSE]
  /\ signal = [s \in Sids |-> FALSE]
  /\ dark = [s \in Sids |-> {}]
  /\ killRace = [s \in Sids |-> FALSE]
  /\ killSig = [s \in Sids |-> FALSE]
  /\ net = {}
  /\ faults = [loss |-> 0, ends |-> 0, restarts |-> 0, overruns |-> 0, hand |-> 0,
               inconclusive |-> 0, createFails |-> 0, drops |-> 0, early |-> 0, unattended |-> 0,
               watches |-> 0]

LockFree == ~WorktreeLock \/ lock = 0
Hold(o) == lock' = IF WorktreeLock THEN o ELSE 0
Spend(f) == faults' = [faults EXCEPT ![f] = @ + 1]
\* The app of Mac m will show session s and take its size.
Show(m, s) ==
  /\ shows' = [shows EXCEPT ![m] = s]
  /\ wants' = [wants EXCEPT ![m] = TRUE]
  /\ fresh' = [fresh EXCEPT ![m] = TRUE]
TakePending(m) == wants[m] /\ rexUp[m]
Opener(m, s) == m \in viaT3[s] \cup byHand[s]
\* The apps the size can pass to when its owner m disconnects.
HeirsOf(s, m) == {h \in desired[s] \ {m} : rexUp[h] /\ (~UnaskedNeverOwns \/ shows[h] = s)}
\* After a record write leaves a pending session with no holder, the code reaps
\* in the same lock hold (`reap` in RexSessions.ts).
ReapIfUnheld(newRec) ==
  IF newRec.st = "pending" /\ newRec.holders = {}
    THEN /\ reapCheck' = TRUE
         /\ Hold(Reaper)
    ELSE /\ reapCheck' = reapCheck
         /\ lock' = lock

ClientVars == <<cl, got, inWindow, late>>
ServerVars == <<srv, seen, lock, rec, reapCheck, reaping, booting>>
MacVars == <<rexUp, t3Up, shows, wants, fresh>>
RexVars == <<alive, created, killed, confirmed, viaT3, byHand, owner, desired>>
GhostVars == <<signal, dark, killRace, killSig, unattended, falseSign>>

---------------------------------------------------------------------------
\* Client

\* You click "Open in Rex"; the client sends "open project {cwd}".
Click(r) ==
  /\ cl[r] = "idle"
  /\ cl' = [cl EXCEPT ![r] = "waiting"]
  /\ inWindow' = [inWindow EXCEPT ![r] = TRUE]
  /\ net' = net \cup {Msg("req", r, NoSid)}
  /\ UNCHANGED <<got, late, ServerVars, MacVars, RexVars, GhostVars, faults>>

\* The server's answer reaches the client. Past its deadline, the client
\* abandons without selecting.
GetSession(r) ==
  \E s \in Sids :
    /\ Msg("resp", r, s) \in net
    /\ t3Up[MacOf(r)]
    /\ IF cl[r] = "waiting"
         THEN IF ClientDeadline /\ ~inWindow[r]
                THEN /\ cl' = [cl EXCEPT ![r] = "done"]
                     /\ net' = (net \ {Msg("resp", r, s)}) \cup {Msg("abandon", r, s)}
                ELSE /\ cl' = [cl EXCEPT ![r] = "selecting"]
                     /\ net' = net \ {Msg("resp", r, s)}
         ELSE /\ net' = net \ {Msg("resp", r, s)}
              /\ UNCHANGED cl
    /\ got' = [got EXCEPT ![r] = IF cl[r] = "waiting" THEN s ELSE @]
    /\ UNCHANGED <<inWindow, late, ServerVars, MacVars, RexVars, GhostVars, faults>>

\* The open request fails or never answers; the client shows "Couldn't open in Rex".
WaitTimesOut(r) ==
  /\ cl[r] = "waiting"
  /\ cl' = [cl EXCEPT ![r] = "done"]
  /\ UNCHANGED <<got, inWindow, late, ServerVars, MacVars, RexVars, GhostVars, net, faults>>

\* `rex -C <this Mac> do session.select` succeeds; the client confirms.
SelectOk(r) ==
  LET s == got[r]
      m == MacOf(r) IN
  /\ cl[r] = "selecting"
  /\ alive[s]
  /\ rexUp[m]
  /\ cl' = [cl EXCEPT ![r] = "done"]
  /\ Show(m, s)
  /\ viaT3' = [viaT3 EXCEPT ![s] = @ \cup {m}]
  /\ net' = net \cup {Msg("confirm", r, s)}
  /\ UNCHANGED <<got, inWindow, late, ServerVars, rexUp, t3Up,
                 alive, created, killed, confirmed, byHand, owner, desired, GhostVars, faults>>

\* Select fails (Rex's error, or the app never connected after a launch);
\* the client abandons.
SelectFails(r) ==
  /\ cl[r] = "selecting"
  /\ cl' = [cl EXCEPT ![r] = "done"]
  /\ net' = net \cup {Msg("abandon", r, got[r])}
  /\ UNCHANGED <<got, inWindow, late, ServerVars, MacVars, RexVars, GhostVars, faults>>

\* The select ends inconclusively: the client's timeout fires, or the app
\* answers "not found" for a session the host just made (Rex 0.1.0 (2061) does,
\* even while it shows the session). The app may still act on the select.
SelectInconclusive(r) ==
  /\ cl[r] = "selecting"
  /\ faults.inconclusive < MaxInconclusive
  /\ Spend("inconclusive")
  /\ cl' = [cl EXCEPT ![r] = "done"]
  /\ late' = [late EXCEPT ![r] = TRUE]
  /\ net' = IF AbandonOnlyOnFailure THEN net ELSE net \cup {Msg("abandon", r, got[r])}
  /\ UNCHANGED <<got, inWindow, ServerVars, MacVars, RexVars, GhostVars>>

\* The app acts on a select the client already gave up on.
LateSelectLands(r) ==
  LET s == got[r]
      m == MacOf(r) IN
  /\ late[r]
  /\ alive[s]
  /\ rexUp[m]
  /\ late' = [late EXCEPT ![r] = FALSE]
  /\ Show(m, s)
  /\ viaT3' = [viaT3 EXCEPT ![s] = @ \cup {m}]
  /\ UNCHANGED <<cl, got, inWindow, ServerVars, rexUp, t3Up,
                 alive, created, killed, confirmed, byHand, owner, desired, GhostVars, net, faults>>

LateSelectDrops(r) ==
  /\ late[r]
  /\ late' = [late EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<cl, got, inWindow, ServerVars, MacVars, RexVars, GhostVars, net, faults>>

\* Time passes: the click's Mac-side work is over before its lease ends. A
\* connected app has also owned the size for a poll interval by then.
WindowCloses(r) ==
  LET m == MacOf(r) IN
  /\ inWindow[r]
  /\ cl[r] = "done" /\ ~late[r] /\ ~TakePending(m) /\ ~(fresh[m] /\ rexUp[m])
  /\ inWindow' = [inWindow EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<cl, got, late, ServerVars, MacVars, RexVars, GhostVars, net, faults>>

\* Fault: the lease ends while the click's Mac-side work is still going. With
\* ClientDeadline this can only happen before the client starts its select.
Overrun(r) ==
  /\ inWindow[r]
  /\ faults.overruns < MaxOverruns
  /\ IF ClientDeadline THEN cl[r] = "waiting"
                       ELSE cl[r] # "done" \/ late[r] \/ TakePending(MacOf(r))
                            \/ (fresh[MacOf(r)] /\ rexUp[MacOf(r)])
  /\ Spend("overruns")
  /\ inWindow' = [inWindow EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<cl, got, late, ServerVars, MacVars, RexVars, GhostVars, net>>

---------------------------------------------------------------------------
\* Each Mac's app and links

\* About a second after it shows a session, a connected app claims its size:
\* it joins `desired` and owns the size.
TakeSize(m) ==
  LET s == shows[m] IN
  /\ TakePending(m)
  /\ wants' = [wants EXCEPT ![m] = FALSE]
  /\ owner' = IF alive[s] THEN [owner EXCEPT ![s] = m] ELSE owner
  /\ desired' = IF alive[s] THEN [desired EXCEPT ![s] = @ \cup {m}] ELSE desired
  /\ UNCHANGED <<ClientVars, ServerVars, rexUp, t3Up, shows, fresh,
                 alive, created, killed, confirmed, viaT3, byHand, GhostVars, net, faults>>

\* The select succeeded but the app claims no size: nobody is at the Mac
\* (seen on an unattended Mac). Only a select through Open in Rex; a hand
\* select has someone at the Mac by definition.
ClaimFails(m) ==
  LET s == shows[m] IN
  /\ TakePending(m)
  /\ m \in viaT3[s] /\ m \notin byHand[s]
  /\ faults.unattended < MaxUnattended
  /\ Spend("unattended")
  /\ wants' = [wants EXCEPT ![m] = FALSE]
  /\ unattended' = [unattended EXCEPT ![s] = @ \cup {m}]
  /\ UNCHANGED <<ClientVars, ServerVars, rexUp, t3Up, shows, fresh, RexVars,
                 signal, dark, killRace, killSig, falseSign, net>>

\* An app puts itself in a session's `desired` list unasked; it does not own
\* the size that way.
AppWatches(m, s) ==
  /\ rexUp[m]
  /\ alive[s]
  /\ m \notin desired[s]
  /\ faults.watches < MaxWatches
  /\ Spend("watches")
  /\ desired' = [desired EXCEPT ![s] = @ \cup {m}]
  /\ UNCHANGED <<ClientVars, ServerVars, MacVars,
                 alive, created, killed, confirmed, viaT3, byHand, owner, GhostVars, net>>

\* A poll interval passes with the app owning the size and the server up.
\* With OwnerLatch the server's poll records it on the pending session. The
\* code polls every second and may latch earlier; the model latches only
\* here, so it allows every kill the code allows.
OwnerSettles(m) ==
  /\ fresh[m]
  /\ ~wants[m]
  /\ ~booting
  /\ LockFree
  /\ fresh' = [fresh EXCEPT ![m] = FALSE]
  /\ rec' = IF OwnerLatch /\ rec.st = "pending" /\ owner[rec.sid] = m
              THEN [rec EXCEPT !.saw = TRUE]
              ELSE rec
  /\ signal' = IF rec.st = "pending" /\ owner[rec.sid] = m
                 THEN [signal EXCEPT ![rec.sid] = TRUE]
                 ELSE signal
  /\ UNCHANGED <<ClientVars, srv, seen, lock, reapCheck, reaping, booting, rexUp, t3Up, shows, wants,
                 RexVars, dark, killRace, killSig, unattended, falseSign, net, faults>>

\* The app disconnects from the host (the Mac sleeps, the network drops). It
\* leaves every `desired` list; a size it owned passes to an heir, or to
\* nobody. A poll has yet to see the heir own it.
RexDrops(m) ==
  /\ rexUp[m]
  /\ faults.drops < MaxDrops
  /\ ~fresh[m] \/ faults.early < MaxEarlyDrops
  /\ faults' = [faults EXCEPT !.drops = @ + 1, !.early = IF fresh[m] THEN @ + 1 ELSE @]
  /\ rexUp' = [rexUp EXCEPT ![m] = FALSE]
  /\ desired' = [s \in Sids |-> desired[s] \ {m}]
  /\ \E heir \in [Sids -> Macs \cup {"none"}] :
       /\ \A s \in Sids :
            owner[s] = m => heir[s] \in IF HandOff /\ HeirsOf(s, m) # {} THEN HeirsOf(s, m) ELSE {"none"}
       /\ owner' = [s \in Sids |-> IF owner[s] = m THEN heir[s] ELSE owner[s]]
       /\ fresh' = [h \in Macs |->
                     IF h = m THEN FALSE ELSE fresh[h] \/ \E s \in Sids : owner[s] = m /\ heir[s] = h]
       /\ falseSign' = [s \in Sids |->
                         falseSign[s] \/ (owner[s] = m /\ heir[s] # "none" /\ ~Opener(heir[s], s))]
  /\ dark' = [s \in Sids |->
                IF m \in viaT3[s] \cup byHand[s] /\ ~signal[s] THEN dark[s] \cup {m} ELSE dark[s]]
  /\ UNCHANGED <<ClientVars, ServerVars, t3Up, shows, wants,
                 alive, created, killed, confirmed, viaT3, byHand,
                 signal, killRace, killSig, unattended, net>>

\* The app reconnects and asks for the size of the session it shows again.
RexReturns(m) ==
  /\ ~rexUp[m]
  /\ rexUp' = [rexUp EXCEPT ![m] = TRUE]
  /\ wants' = [wants EXCEPT ![m] = shows[m] # NoSid]
  /\ fresh' = [fresh EXCEPT ![m] = shows[m] # NoSid]
  /\ UNCHANGED <<ClientVars, ServerVars, t3Up, shows, RexVars, GhostVars, net, faults>>

\* The T3 client loses the server; its messages in flight are gone.
T3Drops(m) ==
  /\ t3Up[m]
  /\ faults.drops < MaxDrops
  /\ Spend("drops")
  /\ t3Up' = [t3Up EXCEPT ![m] = FALSE]
  /\ net' = {x \in net : MacOf(x.r) # m}
  /\ UNCHANGED <<ClientVars, ServerVars, rexUp, shows, wants, fresh, RexVars, GhostVars>>

T3Returns(m) ==
  /\ ~t3Up[m]
  /\ t3Up' = [t3Up EXCEPT ![m] = TRUE]
  /\ UNCHANGED <<ClientVars, ServerVars, rexUp, shows, wants, fresh, RexVars, GhostVars, net, faults>>

---------------------------------------------------------------------------
\* T3 server: one click's request (`receiveOpen` under the worktree lock)

ReceiveOpen(r) ==
  /\ ~booting
  /\ Msg("req", r, NoSid) \in net
  /\ t3Up[MacOf(r)]
  /\ LockFree
  /\ net' = net \ {Msg("req", r, NoSid)}
  /\ srv' = [srv EXCEPT ![r] = "check"]
  /\ Hold(r)
  /\ UNCHANGED <<ClientVars, seen, rec, reapCheck, reaping, booting, MacVars, RexVars, GhostVars, faults>>

\* Read the record; if it names a session, ask `rex ls` whether it is alive.
CheckRecord(r) ==
  /\ srv[r] = "check"
  /\ IF rec.st \in {"pending", "confirmed"} /\ alive[rec.sid]
       THEN /\ srv' = [srv EXCEPT ![r] = "reuse"]
            /\ seen' = [seen EXCEPT ![r] = rec.sid]
       ELSE /\ srv' = [srv EXCEPT ![r] = IF WriteAheadCreate THEN "intent" ELSE "create"]
            /\ UNCHANGED seen
  /\ UNCHANGED <<ClientVars, lock, rec, reapCheck, reaping, booting, MacVars, RexVars, GhostVars, net, faults>>

\* Hand out the session the check found (it may have died since).
Reuse(r) ==
  /\ srv[r] = "reuse"
  /\ rec' = IF Holders /\ rec.st = "pending" /\ rec.sid = seen[r]
              THEN [rec EXCEPT !.holders = @ \cup {r}]
              ELSE rec
  /\ net' = net \cup {Msg("resp", r, seen[r])}
  /\ srv' = [srv EXCEPT ![r] = "done"]
  /\ Hold(0)
  /\ UNCHANGED <<ClientVars, seen, reapCheck, reaping, booting, MacVars, RexVars, GhostVars, faults>>

WriteIntent(r) ==
  /\ srv[r] = "intent"
  /\ rec' = [st |-> "intent", sid |-> r, holders |-> {}, saw |-> FALSE]
  /\ srv' = [srv EXCEPT ![r] = "create"]
  /\ UNCHANGED <<ClientVars, seen, lock, reapCheck, reaping, booting, MacVars, RexVars, GhostVars, net, faults>>

\* `rex new <label> -c <cwd> --json` creates the session on the host.
RexNew(r) ==
  /\ srv[r] = "create"
  /\ alive' = [alive EXCEPT ![r] = TRUE]
  /\ created' = [created EXCEPT ![r] = TRUE]
  /\ srv' = [srv EXCEPT ![r] = "record"]
  /\ UNCHANGED <<ClientVars, seen, lock, rec, reapCheck, reaping, booting, MacVars,
                 killed, confirmed, viaT3, byHand, owner, desired, GhostVars, net, faults>>

\* `rex new` fails or times out, having made the session or not. The server
\* looks it up by its label: found, it is pending with no holder and reaped
\* at once; not found, the record is cleared. The click gets an error.
RexNewFails(r) ==
  /\ srv[r] = "create"
  /\ faults.createFails < MaxCreateFails
  /\ Spend("createFails")
  /\ \E made \in BOOLEAN :
       LET next == IF ~WriteAheadCreate THEN rec
                   ELSE IF made THEN Pending(r, {}) ELSE NoRec IN
       /\ alive' = [alive EXCEPT ![r] = made]
       /\ created' = [created EXCEPT ![r] = made]
       /\ rec' = next
       /\ IF next.st = "pending"
            THEN /\ reapCheck' = TRUE
                 /\ Hold(Reaper)
            ELSE /\ reapCheck' = reapCheck
                 /\ Hold(0)
  /\ srv' = [srv EXCEPT ![r] = "done"]
  /\ UNCHANGED <<ClientVars, seen, reaping, booting, MacVars,
                 killed, confirmed, viaT3, byHand, owner, desired, GhostVars, net>>

\* Persist the session as pending, start its lease, answer the client.
RecordPending(r) ==
  /\ srv[r] = "record"
  /\ rec' = Pending(r, {r})
  /\ net' = net \cup {Msg("resp", r, r)}
  /\ srv' = [srv EXCEPT ![r] = "done"]
  /\ Hold(0)
  /\ UNCHANGED <<ClientVars, seen, reapCheck, reaping, booting, MacVars, RexVars, GhostVars, faults>>

---------------------------------------------------------------------------
\* T3 server: reports, leases, reaping, restart

ReceiveConfirm(r) ==
  \E s \in Sids :
    /\ ~booting
    /\ Msg("confirm", r, s) \in net
    /\ t3Up[MacOf(r)]
    /\ LockFree
    /\ net' = net \ {Msg("confirm", r, s)}
    /\ IF rec.st = "pending" /\ rec.sid = s
         THEN /\ rec' = Confirmed(s)
              /\ confirmed' = [confirmed EXCEPT ![s] = TRUE]
         ELSE UNCHANGED <<rec, confirmed, unattended, falseSign>>
    /\ signal' = [signal EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<ClientVars, srv, seen, lock, reapCheck, reaping, booting, MacVars,
                   alive, created, killed, viaT3, byHand, owner, desired, dark, killRace, killSig, faults, unattended, falseSign>>

ReceiveAbandon(r) ==
  \E s \in Sids :
    LET next == IF rec.st = "pending" /\ rec.sid = s
                  THEN [rec EXCEPT !.holders = @ \ {r}]
                  ELSE rec IN
    /\ ~booting
    /\ Msg("abandon", r, s) \in net
    /\ t3Up[MacOf(r)]
    /\ LockFree
    /\ net' = net \ {Msg("abandon", r, s)}
    /\ rec' = next
    /\ ReapIfUnheld(next)
    /\ UNCHANGED <<ClientVars, srv, seen, reaping, booting, MacVars, RexVars, GhostVars, faults>>

\* Click r's lease ends with no report from it.
LeaseEnds(r) ==
  LET next == [rec EXCEPT !.holders = @ \ {r}] IN
  /\ ~booting
  /\ rec.st = "pending"
  /\ r \in rec.holders
  /\ ~inWindow[r]
  /\ LockFree
  /\ rec' = next
  /\ ReapIfUnheld(next)
  /\ UNCHANGED <<ClientVars, srv, seen, reaping, booting, MacVars, RexVars, GhostVars, net, faults>>

\* `reapOnce`: read whether the session is alive and whether an app owns its
\* size (TakeoverCheck) or a poll saw one (OwnerLatch); either counts as a
\* confirm. Otherwise decide to kill.
Reap ==
  /\ reapCheck
  /\ reaping = NoSid
  /\ reapCheck' = FALSE
  /\ IF rec.st = "pending" /\ rec.holders = {}
       THEN IF TakeoverCheck /\ alive[rec.sid] /\ (owner[rec.sid] # "none" \/ (OwnerLatch /\ rec.saw))
              THEN /\ rec' = Confirmed(rec.sid)
                   /\ confirmed' = [confirmed EXCEPT ![rec.sid] = TRUE]
                   /\ Hold(0)
                   /\ UNCHANGED reaping
              ELSE /\ reaping' = rec.sid
                   /\ UNCHANGED <<rec, confirmed, lock>>
       ELSE /\ Hold(0)
            /\ UNCHANGED <<rec, confirmed, reaping>>
  /\ UNCHANGED <<ClientVars, srv, seen, booting, MacVars,
                 alive, created, killed, viaT3, byHand, owner, desired, GhostVars, net, faults>>

\* `rex kill`, then the record is cleared.
KillSession ==
  LET s == reaping IN
  /\ s # NoSid
  /\ alive' = [alive EXCEPT ![s] = FALSE]
  /\ killed' = [killed EXCEPT ![s] = @ \/ alive[s]]
  /\ killRace' = [killRace EXCEPT ![s] =
                    \E m \in byHand[s] : shows[m] = s /\ (TakePending(m) \/ m \in desired[s])]
  /\ killSig' = [killSig EXCEPT ![s] = @ \/ (alive[s] /\ signal[s])]
  /\ rec' = IF rec.sid = s THEN NoRec ELSE rec
  /\ reaping' = NoSid
  /\ Hold(0)
  /\ UNCHANGED <<ClientVars, srv, seen, reapCheck, booting, MacVars,
                 created, confirmed, viaT3, byHand, owner, desired, signal, dark, net, faults, unattended, falseSign>>

\* The T3 server restarts: everything in memory is gone, the record stays
\* (the latch only with LatchPersisted). Reports in flight are lost.
Restart ==
  /\ ~booting
  /\ faults.restarts < MaxRestarts
  /\ Spend("restarts")
  /\ srv' = [r \in Reqs |-> IF srv[r] \in {"idle", "done", "lost"} THEN srv[r] ELSE "lost"]
  /\ lock' = 0
  /\ reapCheck' = FALSE
  /\ reaping' = NoSid
  /\ booting' = TRUE
  /\ rec' = IF LatchPersisted THEN rec ELSE [rec EXCEPT !.saw = FALSE]
  /\ net' = {x \in net : x.k \in {"req", "resp"}}
  /\ UNCHANGED <<ClientVars, seen, MacVars, RexVars, GhostVars>>

\* `startup`: an intent whose labelled session exists becomes pending with no
\* holder; a pending session with holders gets a fresh lease per holder, one
\* with none is reaped. Without RestartRearm a pending session is killed.
Startup ==
  LET next == CASE rec.st = "intent" ->
                     IF alive[rec.sid] THEN Pending(rec.sid, {}) ELSE NoRec
                [] rec.st = "pending" /\ ~RestartRearm -> NoRec
                [] OTHER -> rec IN
  /\ booting
  /\ booting' = FALSE
  /\ rec' = next
  /\ IF rec.st = "pending" /\ ~RestartRearm
       THEN /\ alive' = [alive EXCEPT ![rec.sid] = FALSE]
            /\ killed' = [killed EXCEPT ![rec.sid] = @ \/ alive[rec.sid]]
            /\ killSig' = [killSig EXCEPT ![rec.sid] = @ \/ (alive[rec.sid] /\ signal[rec.sid])]
       ELSE UNCHANGED <<alive, killed, killSig, unattended, falseSign>>
  /\ ReapIfUnheld(next)
  /\ UNCHANGED <<ClientVars, srv, seen, reaping, MacVars,
                 created, confirmed, viaT3, byHand, owner, desired, signal, dark, killRace, net, faults, unattended, falseSign>>

---------------------------------------------------------------------------
\* Rex, the user, the network

\* You close the session in Rex, or its shell exits.
SessionEnds(s) ==
  /\ alive[s]
  /\ faults.ends < MaxEnds
  /\ Spend("ends")
  /\ alive' = [alive EXCEPT ![s] = FALSE]
  /\ owner' = [owner EXCEPT ![s] = "none"]
  /\ desired' = [desired EXCEPT ![s] = {}]
  /\ UNCHANGED <<ClientVars, ServerVars, MacVars,
                 created, killed, confirmed, viaT3, byHand, GhostVars, net>>

\* Every app lists every session on the host, so you can click it by hand.
HandSelect(s, m) ==
  /\ alive[s]
  /\ rexUp[m]
  /\ faults.hand < MaxHand
  /\ Spend("hand")
  /\ Show(m, s)
  /\ byHand' = [byHand EXCEPT ![s] = @ \cup {m}]
  /\ UNCHANGED <<ClientVars, ServerVars, rexUp, t3Up,
                 alive, created, killed, confirmed, viaT3, owner, desired, GhostVars, net>>

Lose(x) ==
  /\ x \in net
  /\ faults.loss < MaxLoss
  /\ Spend("loss")
  /\ net' = net \ {x}
  /\ UNCHANGED <<ClientVars, ServerVars, MacVars, RexVars, GhostVars>>

---------------------------------------------------------------------------

Next ==
  \/ \E r \in Reqs :
       \/ Click(r) \/ GetSession(r) \/ WaitTimesOut(r)
       \/ SelectOk(r) \/ SelectFails(r) \/ SelectInconclusive(r)
       \/ LateSelectLands(r) \/ LateSelectDrops(r)
       \/ WindowCloses(r) \/ Overrun(r)
       \/ ReceiveOpen(r) \/ CheckRecord(r) \/ Reuse(r) \/ WriteIntent(r)
       \/ RexNew(r) \/ RexNewFails(r) \/ RecordPending(r)
       \/ ReceiveConfirm(r) \/ ReceiveAbandon(r) \/ LeaseEnds(r)
  \/ \E m \in Macs :
       \/ TakeSize(m) \/ ClaimFails(m) \/ OwnerSettles(m)
       \/ RexDrops(m) \/ RexReturns(m) \/ T3Drops(m) \/ T3Returns(m)
  \/ Reap \/ KillSession \/ Restart \/ Startup
  \/ \E s \in Sids : SessionEnds(s) \/ \E m \in Macs : HandSelect(s, m) \/ AppWatches(m, s)
  \/ \E x \in net : Lose(x)

\* Fair: the server's own steps, the Mac-side steps (a Mac that stops forever
\* mid-click is an Overrun), and a confirm reaching a reachable server (a
\* confirm that never arrives is a Lose or a link drop). Not fair: other
\* deliveries, and links coming back.
Fairness ==
  /\ \A r \in Reqs :
       /\ WF_vars(CheckRecord(r)) /\ WF_vars(Reuse(r)) /\ WF_vars(WriteIntent(r))
       /\ WF_vars(RexNew(r)) /\ WF_vars(RecordPending(r)) /\ WF_vars(LeaseEnds(r))
       /\ WF_vars(SelectOk(r) \/ SelectFails(r) \/ WaitTimesOut(r))
       /\ WF_vars(LateSelectLands(r) \/ LateSelectDrops(r))
       /\ WF_vars(WindowCloses(r)) /\ WF_vars(ReceiveConfirm(r))
  /\ \A m \in Macs : WF_vars(TakeSize(m)) /\ WF_vars(OwnerSettles(m))
  /\ WF_vars(Reap) /\ WF_vars(KillSession) /\ WF_vars(Startup)

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
\* Rules

\* (a) T3 never kills a session a Mac selected through Open in Rex. Does not
\* hold, by design: see SelectedKillOnlyWithoutSign.
NeverKillSelected == \A s \in Sids : killed[s] => viaT3[s] = {}

\* (a') T3 never kills a session the user opened by hand in a Rex app. Does
\* not hold, by design: see HandKillOnlyInAcceptedGaps.
NeverKillOpenedByHand == \A s \in Sids : killed[s] => byHand[s] = {}

\* Once a confirm or a latched owner exists, the session is the user's and is
\* never killed.
NeverKillSignalled == \A s \in Sids : ~killSig[s]

\* Only an app that opened the session ever owns its size, so an app in
\* `desired` unasked never makes a session look opened (and kept forever).
NoFalseSign == \A s \in Sids : ~falseSign[s]

\* (a) as Wenxuan accepted it (2026-11-18): a session a Mac selected is killed
\* only when the host never had any sign it was opened: every Mac that
\* selected it went offline before a sign, or claimed no size because nobody
\* was at it. That session is dangling; cleaning it up is intended.
SelectedKillOnlyWithoutSign ==
  \A s \in Sids : killed[s] => viaT3[s] \subseteq dark[s] \cup unattended[s]

\* (a') as Wenxuan accepted it (2026-11-18): a session you opened by hand is
\* killed only in the gap of about 1-2 s before your app's size takeover
\* reaches the host, while the reaper is checking or about to kill, or after
\* your Mac went offline before the host had any sign it was opened.
HandKillOnlyInAcceptedGaps ==
  \A s \in Sids : killed[s] /\ byHand[s] # {} => killRace[s] \/ byHand[s] \subseteq dark[s]

\* (b, safety half) Every live session T3 created is confirmed, named by the
\* record, or about to be recorded by the running request that created it.
NoOrphan == \A s \in Sids : alive[s] => confirmed[s] \/ rec.sid = s \/ srv[s] = "record"

\* (b) Every session T3 created is eventually confirmed or gone.
NoDangling == \A s \in Sids : created[s] ~> (confirmed[s] \/ ~alive[s])

\* (c) At most one live T3-created session for the worktree.
OneSessionPerWorktree == Cardinality({s \in Sids : alive[s]}) <= 1

\* (d) T3 kills only a session it created that was never confirmed: never one
\* the user already had when they clicked.
KillsOnlyUnconfirmed == \A s \in Sids : killed[s] => created[s] /\ ~confirmed[s]

=============================================================================
