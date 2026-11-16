# Super threads

A super thread coordinates one task that spans several projects or machines. You describe the goal.
Its agent starts threads where the work belongs and keeps a goal board. All of those threads stay
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

Select the header to open the super thread's page: the goal, the board, its threads, any approvals
it is waiting on, and a box to message it. The board is read-only; ask the agent to change it.
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
