# Asking the pylon which dialogs wait only when something may have changed

Verified in this task's pylon on 2026-10-30, on branch `simplify/w3-claude-conversation` at 44cfaa4 against main at 90f4299, with Claude Code 2.1.310 on Sonnet 5.5 and Node 26. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/ask-pull-gate/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each and runs `stack.ts drive` there. Each run's captures land in `main/` or `branch/`. `RUNS=main` or `RUNS=branch` runs one of them. It needs passwordless sudo and the Claude token placeholder in `/etc/profile.d/nexus-secrets.sh`, as a pylon has.

## The stack

`stack.ts` is [ask-user-question-card's stack](../ask-user-question-card/README.md) without the browser. The real control plane and probe of the checkout run in child processes. The probe's one pylon is this machine as the Linux user `verify`, where the real Claude Code runs the checkout's hooks, and the hooks post to the probe's pylon API on 127.0.0.1.

The driver starts a Claude worker whose prompt runs `sleep 45` with Bash and then calls AskUserQuestion with one question, "Which size?". It holds the thread's transcript stream open, as the thread page does, so the control plane reads the running turn every 2 seconds. It counts the probe's runs of `nexus-claude-hook asks` in `guest.log` from the Bash call until the thread waits or its card shows. It then answers the card with Large through `POST /v1/questions/:id/answer`, the dashboard's route, waits for the turn to end and counts the runs over the next 20 seconds.

## Main (`main/`) and this branch (`branch/`)

| | main, 90f4299 | this branch |
|---|---|---|
| `asks` runs while the watched turn ran its Bash command, `timeline.txt` | 28 in 52.6 s | 2 in 52.9 s |
| The card, `03-show-asked.txt` | showed 0.2 s after the thread waited | showed 0.2 s after the thread waited |
| The answer, `answer.txt`, `04-conversation-answered.txt` | HTTP 200, and Claude got `"Which size?"="Large"` | the same |
| `asks` runs in the 20 s after the turn ended | 0 | 0 |
| Session events, `session-events.txt` | no `session.waiting` | `session.waiting` with no message 5 ms after the hook's waiting record is stamped |
| The waiting file, `asks-asked.txt` | `<key>.waiting`, starting with `pid`, `start`, `session` | `<sha256(session)>.<key>.waiting`, starting with `pid`, `start`, `at` |

The branch's runs in `branch/guest.log` are at +4.8 s, the reader's first read, and +12.8 s, after the Bash call's heartbeat. The rest come from +57.8 s on, after the hook's `session.waiting` event, and each read repeats them while the ask is open, as before. The dialog's Notification reported no `session.waiting` in either run. On main the card opened only because the working reads asked every 2 seconds. On the branch it opened from the hook's own event.
