# Hook outbox across a probe outage

`run.sh` ran in this thread's pylon on 2026-10-26 and wrote `run.log`. Claude Code 2.1.308 ran one real turn (`claude -p`, asked to run `sleep 20` and reply). Its hooks were this branch's `images/pylon/nexus-claude-hook`, `nexus-outbox.ts`, `nexus-heartbeat.ts` and `nexus-turn.ts`, installed as `install.ts` installs them. The hook's checkout path pointed at a scratch repository, so the turn snapshot left the thread's own checkout alone. `NEXUS_API` pointed at `stand-in-probe.ts`, not the node's probe. The stand-in is the probe's own pylon API and event journal, plus a registry that applies each journaled report as control does. It leaves out the VM bridge and the observe link: on start it replays its journal into the registry, as a snapshot would.

What the log shows:

- The probe journaled the turn start (sequence 1), and the registry marked the session working.
- The script killed the probe with SIGKILL. Claude ran its tool, ended its turn and its session, and replied `done` without waiting on the probe. The heartbeat, turn end and session end were in `~/.nexus/outbox` as three files, and one sender was still running.
- 15 seconds later the probe came back. It replayed sequence 1 from its journal. The sender delivered the outbox in order within its 10-second backoff.
- The restarted probe dropped its first answer after journaling, as a probe that dies between its commit and its reply would. The sender sent that heartbeat again. The probe journaled it a second time under the same ID (sequences 2 and 3), and the registry applied it once: the public event log holds one `session.heartbeat`.
- After the turn end, the session no longer runs and `lastReplyAt` is set. The outbox is empty and the sender has exited.

Rerun it with `docs/verification/hook-outbox/run.sh` from the repository, in a pylon with Claude Code logged in. It never reaches the node's probe.

The run predates [#93](https://github.com/ramtinJ95/nexus/pull/93). Since then the hook reports only for a Claude under the pylon user's own HOME, and `run.sh` gives Claude a scratch HOME, so it now reports nothing. To run it again, run it as a separate Linux user, as `docs/verification/claude-activity-accuracy/` does.
