# One Claude session per thread across wakes

Verified in this task's pylon on 2026-10-26, against Herdr 0.9.5 and the installed Claude Code, with no live control
plane, node or other thread involved.

`sandbox.sh` runs `verify-wakes.ts` as `user` in a private mount namespace whose `/home/user` is a scratch home.
That namespace has its own `herdr --session nexus` server, its own `~/.nexus/sessions.json` and Claude state, the
image's Herdr config (`resume_agents_on_restore = false`), and only Herdr's SessionStart hook, so nothing reports to the
control plane. The pylon's own Herdr server is untouched. Claude logs in with the pylon's `CLAUDE_CODE_OAUTH_TOKEN`.

The driver launches a worker with the real prompted `openSession` in a workspace titled "Fix the login page". It then
pauses and wakes three times. A pause waits 15 s, so Herdr has saved its layout as it has after minutes in a real
pylon. It records the sessions with `recordSessions` and SIGKILLs every process in the namespace but the driver, as
a stopped VM does. A wake runs the relaunch, and as soon as Herdr answers, a message through `sendToClaude`, as the
inbox sends once the probe reports the pylon running. On this branch both go through `relaunchAfterWake` and
`onePerClaudeSession`, as the probe runs them. On main the relaunch shared no lock with sends, so the driver runs main's
`relaunchSessions` and `sendToClaude` side by side. After each wake it counts the `claude` processes whose command
line names the worker's session, from `/proc`, and lists Herdr's workspaces.

```
SCRATCH=/tmp/sb docs/verification/one-claude-session/sandbox.sh after-fix
```

## Before: main at 989a8f2

`before-fix.txt`. The count goes 1, 2, 3, 4, one more "Claude Code" workspace per wake, as on thread
th-22cca2f8c03f. When the message goes, Herdr has restored `w1:p1` as a shell with no agent and no session ID. The send
finds no pane running the session, so it opens a "Claude Code" workspace and resumes the session there, while the
relaunch starts it again in `w1:p1`. The next pause records both panes under the same ID, and every wake relaunches
each record.

An earlier run that paused before Herdr first saved its layout (`session file is missing` in Herdr's log) restored
nothing. Its count was 1, 2, 2, 2. The send and the relaunch each opened a workspace for the one session.

## After: this branch

`after-fix.txt`. The count is 1 after the launch and after each of the three wakes. The session stays in w1, the
thread's own workspace, and every message goes there. The relaunch took the lock first in this run. The unit tests in
`src/session-wake.test.ts` cover the other order, a send first, and a Herdr that restored nothing.

## Not verified here

A real pylon VM pause and wake through the probe and the control plane. A pylon that already holds duplicate records,
such as th-22cca2f8c03f's, was checked only by the unit test that drops and closes the extra panes.
