# Asking the pylon which dialogs wait only when something may have changed

Verified in this task's pylon on 2026-10-30, on branch `simplify/w3-claude-conversation` at 674fed6 against main at 90f4299, with Claude Code 2.1.310 on Sonnet 5.5 and Node 26. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/ask-pull-gate/run.sh origin/main HEAD
```

`run.sh` checks out main, the branch, and the branch with main's `images/pylon` into three worktrees, copies `stack.ts` into each and runs `stack.ts drive` there. Each run's captures land in `main/`, `branch/` or `mixed/`. The mixed run is the branch's control plane with a pylon whose hooks are from an image before it, which sends no event of its own once a dialog waits. `RUNS` picks the runs, such as `RUNS=branch`. It needs passwordless sudo and the Claude token placeholder in `/etc/profile.d/nexus-secrets.sh`, as a pylon has.

## The stack

`stack.ts` is [ask-user-question-card's stack](../ask-user-question-card/README.md) without the browser. The real control plane and probe of the checkout run in child processes. The probe's one pylon is this machine as the Linux user `verify`, where the real Claude Code runs the checkout's hooks, and the hooks post to the probe's pylon API on 127.0.0.1.

The driver starts a Claude worker whose prompt runs `sleep 45` with Bash and then calls AskUserQuestion with one question, "Which size?". It holds the thread's transcript stream open, as the thread page does, so the control plane reads the running turn every 2 seconds. It counts the probe's runs of `nexus-claude-hook asks` in `guest.log` from the Bash call until the thread waits or its card shows. It waits 20 seconds, as a person takes a while, then answers the card with Large through `POST /v1/questions/:id/answer`, the dashboard's route, waits for the turn to end and counts the runs over the next 20 seconds.

## Main (`main/`), this branch (`branch/`) and the branch with main's hooks (`mixed/`)

The times are wall clock, measured from the `at` of the hook's waiting record in `asks-asked.txt`, which is when the dialog's PermissionRequest hook started.

| | main, 90f4299 | this branch | mixed |
|---|---|---|---|
| `asks` runs while the watched turn ran its Bash command, `timeline.txt` | 28 in 51.1 s | 3 in 52.5 s | 2 in 169.7 s |
| The card showed, `timeline.txt` | +1.0 s | +1.6 s | +1.4 s |
| What made the pull that opened it, `session-events.txt`, `guest.log` | the 2 s working reads | the hook's own `session.waiting`, stamped +6 ms | the Bash call's PostToolUse heartbeat, stamped 1.5 s before the dialog and ingested after the outbox's 2 s settle |
| The dialog's Notification, `session.waiting` | +6.0 s | +6.0 s | +6.0 s |
| The answer, `answer.txt`, `04-conversation-answered.txt` | HTTP 200, and Claude got `"Which size?"="Large"` | the same | the same |
| `asks` runs in the 20 s after the turn ended | 0 | 0 | 0 |
| The waiting file, `asks-asked.txt` | `<key>.waiting`, starting with `pid`, `start`, `session` | `<sha256(session)>.<key>.waiting`, starting with `pid`, `start`, `at` | as main |

The branch's runs in `branch/guest.log` are at +4.8 s, the reader's first read, and +11.8 s, after the Bash call's heartbeat. The third comes from the hook's `session.waiting` event. Each read after it asks again while the ask is open, as before.

In the mixed run the Bash call's heartbeat happened to open the card. Without it, a pylon whose hooks are from before the branch gets the card from the read after the dialog's Notification. That Notification came 6.0 s after the dialog in all three runs, well after the waiting file, so the race between it and the file did not show. Such a pylon's card waits about 8 s, the Notification plus the outbox's settle, rather than the 2 s of main's working reads, until the pylon moves to a newer image.
