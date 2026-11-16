# Super threads

A super thread coordinates one task that spans several projects or machines. You describe the goal.
Its agent starts threads where the work belongs and draws its plan as a task map. All of those threads stay
together in one sidebar section, so you can tell which threads belong to which task.

## Start one

Open the command palette and choose **New super thread**. Describe the goal and send. The super
thread runs without a project, and its agent starts threads in your projects, including projects on
linked machines.

Only you can start a super thread. An agent can't turn its own thread into one.

## The section and the page

Each super thread gets its own sidebar section, above your other threads. The super thread is the
section's header, and the threads it started are listed under it, those that need you or are done
first. They don't appear in your other sections.

Select the header to open the super thread's page: the goal, the task map, any approvals it is
waiting on, and a box to message it.

## The task map

The map shows the agent's plan: each box is a piece of the work, and an arrow means the work on its
right waits for the work on its left. Groups of related work share a lane. A box shows what its
threads are doing right now, such as working or waiting for you, and otherwise what the agent says:
planned, blocked, done or dropped. Hover over a box for its purpose and what counts as done; select
it to open its thread.

The map is read-only. To change the plan, tell the agent, here or in the transcript. To ask about
part of the map, paste a screenshot into the message box. When the agent changes the plan while you
are away, the page lists what changed and marks new boxes.

Threads the agent started but did not put on the map are listed under **Not on the map**.
**Open transcript** shows the full conversation.

## Which threads belong

A thread belongs to a super thread only when that super thread started it. You can't add or remove
threads, and a thread belongs to at most one super thread. If you start a thread yourself and ask the
super thread to watch it, the agent can read and message that thread, but it stays outside the
section.

## Settle and reopen

Settling the super thread settles every thread in its section. If any of them is still working,
waiting for your answer, or on a machine T3 Code can't reach right now, you are asked first.
Settling stops a thread that is still running, and can dismiss the open questions of a thread
that waits for your answer. A thread that starts
new work after you confirm stays open.

A settled thread goes to the Settled shelf like any other. When one of them comes back, the section
comes back with it. When you message a settled super thread, only the super thread returns: its
finished threads stay settled, and new threads it starts join the section.
