# Super threads

A super thread is a coordinator thread that launches threads in many projects and
environments to finish one task. Without it, those threads scatter across the
sidebar by project and nobody can tell which belong to the task. A super thread
groups them in one sidebar section and shows a task map its agent draws.

This is a fork-only feature. Its code lives in its own files and touches upstream
files only through short seams, so the nightly rebase rarely conflicts.

## Decisions

- **Only a person creates a super thread.** The kind is fixed at creation
  (`superThread` on the thread, schema in
  [`superThread.ts`](../../packages/contracts/src/superThread.ts)). Clients and
  the fork's MCP bridge (`apps/mcp`) can create one. No tool on the server's own
  `/mcp` can, so an agent inside T3 never turns into a coordinator by itself.
- **A super agent delegates by default.** Its role text
  ([`superThreadRole.ts`](../../apps/server/src/superThread/superThreadRole.ts)),
  sent with every prompt, has it plan, launch members, track them on the map and
  combine their results, and keeps project work out of the super thread so it
  shows on the map and in the group. The text calls these defaults: the user's
  own instructions or skills about coordinating win. It still has to work with
  none of them. Eval: `evals/mcp-tool-use/cases/super-threads.ndjson`.
- **The super thread's member list is the only source of truth.** Members are
  `(environmentId, threadId)` pairs stored on the super thread. A child never
  records its parent. A child can therefore live on an older or remote host, and
  removing or adding never needs a write on the child's machine.
- **Members come only from the super thread's own launches.** `t3_thread_launch`
  (local, or forwarded with `environmentId`) and `create_threads` add the thread
  they create. `delegate_task` children do not join; they stay inside the
  parent's view as today. There is no add, remove or move, by design. A thread
  the super agent only watches or messages never joins. That one rule also makes
  "a thread belongs to at most one super thread" true without a cross-machine
  check, and it rules out nesting: a member is an ordinary thread, so what it
  launches belongs to no group.
- **The list is append-only.** A local launch records the member before it
  dispatches the launch, because the thread id is known first. The remote host
  picks the id of a launch in a linked environment, so the super thread writes
  the launch down as pending before it goes and records the thread when the
  result returns. A failed call stays pending, since the thread may exist there
  anyway. After a restart the server sends each launch still pending again with
  its original `clientRequestId`, which such a launch must carry. The remote host
  scopes that key by this environment's link session, which a restart keeps, so
  it answers with the thread it already made instead of making a second one. A
  member whose thread never came to exist is simply not shown.
- **The sidebar section is derived on the client.** A section is shown while the
  super thread or any member is unsettled. It lists the super thread as its
  header and the unsettled members below it: members needing the person (or
  failed) first, then working ones, then finished ones, by the task map's own
  definitions so a row and its map node never disagree. Grouped threads leave
  Pinned, Active and Working.
  Settled members sit on the Settled shelf like any thread. A client that cannot
  reach the super thread's environment shows its members as ordinary threads.
  Mobile lists every super thread as a row under one heading and shows a super
  thread's members one level down, in place of the list, so a super thread and
  its members are never rows at the same level of the native list.
- **Settling the header settles the group; unsettling it does not.** Settling the
  super thread asks for confirmation, listing members that are running, waiting
  for input, or unreachable, then settles the header and every unsettled member.
  Each is an ordinary settle, the same as settling that thread alone, so settle
  and unsettle mean one thing for every thread. A member the server refuses (one
  still working, say) stays unsettled and keeps the section, under a settled
  header. Unsettling the header returns only the header: settled members are
  done, and a returning header means a new task. A member that unsettles brings
  the section back through the derivation above, with no write to the header.
- **A member's outcome wakes the super thread.** When a member's run completes,
  fails, or starts waiting for the person, the server queues one notice on the
  super thread, as a finished `delegate_task` child wakes its parent. The
  `super_thread.member.wake` command decides it under the super thread's command
  lock, keyed by the outcome so a replay wakes it once. An outcome that arrives
  while a notice is still queued joins that notice, so a busy super thread gets one
  turn for all of them. A settled or archived super thread is not woken: settled
  means done, and the member's state shows in the sidebar. Settling cancels a
  queued notice, and one already running makes the settle refuse, as any busy
  thread does. Members here are read from this server's events.
  A run the super thread starts on a member in a linked environment (launch or
  `t3_thread_send`) is recorded on the super thread and followed with the same
  wait `RemoteDelegation` uses, so a restart resumes it. That wait returns only
  when the run ends, so a linked member waiting for the person does not wake it.
- **The task map is the super agent's, and read-only for people.** Super-thread-only
  MCP tools patch it by node and edge id and read it back. It lives on the thread,
  not in a run's plan artifact, because it must outlive any single run. Each patch
  carries a reason, kept in a short change log so clients can show what changed
  since a person last looked at the map.
- **The agent picks the structure, the system draws it.** The agent chooses the
  nodes, groups, edges and words. Clients own the look and the layout: a lane per
  group, columns from `depends` edges, computed from ids and edges only so a status
  change never moves a node. The agent never sends coordinates.
- **Threads outrank the agent on a node's state.** A linked thread that is working,
  waiting for the person or failed shows over the agent's status, so a map the agent
  forgot to update can't claim progress that isn't happening. The agent's status
  covers what threads can't show: planned, blocked, done and dropped. Nodes link
  only members, so every node's threads belong to this group.
- **The conversation is the super thread's page.** Every way in, the section header
  included, opens the normal chat route, so the composer, pickers, approvals and
  questions work as in any thread. The goal, the map and members not on the map live
  in a panel that opens only when the person asks: a right-panel surface on the web,
  the auxiliary pane on mobile (a sheet on iPhone). "Since you last looked" counts
  from the previous time that panel was on screen, kept per client, because the
  conversation moves the thread's own visit mark while the person chats.

## Verification

The settle, unsettle, launch, wake and visibility rules are model-checked with TLA+.
See the `verify-super-threads` skill.
