# Open in Rex

**Open in… → Rex** opens a thread's folder in [Rex](https://www.superlogical.com/rex/docs), a
terminal multiplexer, in the Rex app on the Mac you are using. The shell runs on the machine
that hosts the project, so it works for remote environments too.

## What it needs

- The T3 desktop app on a Mac with Rex for Mac installed. In a browser or on a phone, the entry
  says to open it from the desktop app.
- Rex on the machine that hosts the project, with its server running. When it is missing or
  stopped, the entry says why instead of opening.
- That machine in the Mac's Rex host list, so the Rex app can show its sessions.

If the Rex app isn't running, T3 starts it.

## Sessions

Each project folder gets one Rex session, named after the folder. Opening it again, from this
Mac or another, goes back to the same session while it is open. If you closed it, T3 starts a
new one.

A session that never reached a Rex app, for example because the Mac couldn't find it, is closed
again within about 30 seconds. One you can see in Rex stays until you close it.
