# Super threads

A super thread coordinates one task that spans several projects or machines. You describe the goal.
Its agent starts threads where the work belongs and draws its plan as a task map. All of those threads stay
together in one sidebar section, so you can tell which threads belong to which task.

## Start one

Open the command palette and choose **New super thread**. Describe the goal and send. The super
thread runs without a project, and its agent starts threads in your projects, including projects on
linked machines.

Only you can start a super thread. An agent can't turn its own thread into one.

The super thread's agent hands the work to the threads it starts instead of doing it itself. If your
own agent instructions or skills say how a super thread should coordinate, for example that it may
make small changes itself, the agent follows them.

## The section and the panel

Each super thread gets its own sidebar section, above your other threads. On the web and desktop,
the super thread is the section's header, and the threads it started are listed under it. On
mobile, your super threads are listed together under **Super threads**, above your other threads;
tap one to open its conversation and show the threads it started in place of the list, and tap
**Super threads** above them to go back. Either way, those threads don't appear in your other
sections. Threads that need you, such as those waiting for an answer or approval or whose run
failed, come first. Threads still working, including those waiting on their own background work,
come next, and finished threads come last. Within each group the most recently active thread is on
top, and threads move as their state changes.

A thread in the section works like any other thread row: hover over it on the web and desktop to
settle it, or right-click it to rename, archive or delete it. On mobile, swipe it to settle, or
touch and hold for the same menu; a super thread's own row works the same way. Pin and snooze aren't
offered there, because the section always lists its threads that aren't settled, in its own order.

On the web and desktop, select the arrow at the end of a section's header to hide its threads, and
select it again to show them. A folded section shows how many threads it hides, or, when any of
them needs your answer or has failed, how many need you. Each device remembers which sections you
folded. On mobile, a super thread's row shows the most urgent status among it and its threads, and
says how many of them need you; it shows Done only once all of them are done.

When a thread in the section finishes, fails, or needs your answer, the super thread's agent picks
it up on its own. Several that change while the agent is busy reach it together. For a thread on a
linked machine, the agent hears when a run it started there ends, but not when that thread waits
for you; the sidebar shows that.

## Notifications

Threads a super thread starts never notify you on the web, desktop or phone; what they do goes to
the super thread's agent instead. The super thread notifies you when its turn ends and none of its
threads are still working, or when one of them is waiting for your answer. While its threads work,
a super thread that has ended its turn still shows as working.

Select the header, or on mobile the super thread's row, to open its conversation, which works like
any other thread. To see the goal and the task map beside it, select **Super thread** in the header
or **Task map** in the thread details, or choose **Show goal and task map** in the command palette.
Select **Super thread** again to hide them. The thread details also show how much of the map is done
and whether any of it needs you. On iOS, **Super thread** is under the Panels button in the
thread's header.

## The task map

The map shows the agent's plan: each box is a piece of the work, and an arrow means the work on its
right waits for the work on its left. Groups of related work share a lane. A box shows what its
threads are doing right now, such as working or waiting for you, and otherwise what the agent says:
planned, blocked, done or dropped. Hover over a box for its purpose, the agent's latest note and
related work; select it to open its thread. On mobile, the map fits the panel's width; drag to move
around it and pinch to zoom, or choose the full screen button in the panel's header for more room.
Tap a box to open its thread, or to see its details when it has none; touch and hold a box to see
its details, including the work it waits for or relates to.

The map is read-only. To change the plan, tell the agent in the conversation. To ask about part of
the map, paste a screenshot into the message box. When the agent changes the plan while the map is
hidden, the panel lists what changed and marks new boxes the next time you open it.

Threads the agent started but did not put on the map are listed under **Not on the map**.

## Which threads belong

A thread belongs to a super thread only when that super thread started it. You can't add or remove
threads, and a thread belongs to at most one super thread. If you start a thread yourself and ask the
super thread to watch it, the agent can read and message that thread, but it stays outside the
section.

## Settle and reopen

Settling one thread in the section settles only that thread, and it still belongs to the super
thread. Settling the super thread settles every thread in its section. If any of them is still working,
waiting for your answer, or on a machine T3 Code can't reach right now, you are asked first.
Settling stops a thread that is still running, and can dismiss the open questions of a thread
that waits for your answer. A thread that starts
new work after you confirm stays open.

A settled super thread is not woken when one of its threads finishes later; that thread shows in
the sidebar instead. A settled thread goes to the Settled shelf like any other. When one of them comes back, the section
comes back with it. When you message a settled super thread, only the super thread returns: its
finished threads stay settled, and new threads it starts join the section.
