# A session is not paused once its pylon runs

Verified in this task's pylon on 2026-10-26, against Herdr 0.9.5 and the installed Claude Code. No live control plane,
node or other thread was involved.

`sandbox.sh` runs `verify.ts` as `user` in a private mount namespace whose `/home/user` is a scratch home, as
`docs/verification/one-claude-session/` does. That namespace has its own `herdr --session nexus` server, sessions file
and Claude state. The driver runs the real control-plane loop, registry and ingest. They follow the real probe server
over HTTP, and the probe's backend runs its guest execs in the namespace. A pause records the sessions with
`recordBeforePause` and SIGKILLs every process in the namespace but the driver, as a stopped VM does. A wake runs
`relaunchAfterWake`. The driver prints each change in what `nexus show` would print for the session.

```
SCRATCH=/tmp/sb docs/verification/session-state-after-wake/sandbox.sh after-fix fail-reads
SRC=/path/to/a/main/worktree SCRATCH=/tmp/sb docs/verification/session-state-after-wake/sandbox.sh before-fix fail-reads
```

With `fail-reads`, the probe's `herdr api snapshot` fails from the wake on, for about 10 seconds. A read that times
out or does not parse fails the same way. The relaunch and the sends are not affected.

## Before: main at 3059974

`before-fix.txt`. After the wake the pylon runs and one Claude runs the worker's session, but the session reads
`paused (resumes on wake)` until a read succeeds. The probe logs nothing about the failed reads. This matches thread
th-1c31826b7c5f: a running pylon, one live `claude --resume`, and a paused session.

## After: this branch

`after-fix.txt`. The first running observation after the wake resumes the session in its pane with status `unknown`.
The probe logs the failed read once. The first read that succeeds gives Herdr's status, `idle`. `reads-work.txt` is
the same run with reads that work: `unknown` for the moment before the first read, then `idle`.

## Not verified here

A real pylon VM pause and wake, and why the probe's reads of th-1c31826b7c5f failed. That pylon could not be read
from here, and a sandboxed read of a woken Herdr took 4 to 106 ms, well inside the probe's 3 s budget. The new probe
log line names the cause the next time it happens.
