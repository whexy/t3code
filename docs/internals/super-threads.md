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
  dispatches the launch, because the thread id is known first. A launch in a
  linked environment can only be recorded after its result returns, since the
  remote host picks the id. A member whose thread never came to exist is simply
  not shown.
- **The sidebar section is derived on the client.** A section is shown while the
  super thread or any member is unsettled. It lists the super thread as its
  header and the unsettled members below it, members needing input or done first
  and working ones last. Grouped threads leave Pinned, Active and Working.
  Settled members sit on the Settled shelf like any thread. A client that cannot
  reach the super thread's environment shows its members as ordinary threads.
- **Settling the header settles the group; unsettling it does not.** Settling the
  super thread asks for confirmation, listing members that are running, waiting
  for input, or unreachable, then settles the header and every unsettled member.
  Every settle, the header's included, carries `expectedLatestRunId` from what the
  confirmation showed (`null` for a thread with no run yet), so a thread that
  started new work after the person confirmed refuses and stays in the section. Unsettling the header returns only the header: settled members are
  done, and a returning header means a new task. A member that unsettles brings
  the section back through the derivation above, with no write to the header.
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
  in a right-panel surface that opens only when the person asks. "Since you last
  looked" counts from the previous time that panel was on screen, kept per client,
  because the conversation moves the thread's own visit mark while the person chats.

## Verification

The settle, unsettle, launch and visibility rules are model-checked with TLA+.
See the `verify-super-threads` skill.
