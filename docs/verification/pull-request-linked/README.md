# An event for each pull request the PR watch links

Verified in this task's pylon on 2026-10-28, on branch `feat/pull-request-linked-event` at c2966a5 (code and docs; the capture's own commit follows it), against main at 6fa9d01. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
docs/verification/pull-request-linked/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test. Then it runs the branch's two new tests against each run's code, into `tests.txt`.

`stack.ts` runs the real registry, API, PR watch and inbox, wired as `src/control/main.ts` wires them, with the real `githubClient`, on 127.0.0.1:7470. Docker is not available in this pylon, so the verify-nexus stack could not run, and its scripted model would not open a pull request anyway. GitHub is a fetch handler that keeps the PRs. Builders are Claude workers with no Claude Code: each pushes the branch its prompt names, leaving the branch output a pylon's report would. The PR watch polls every 2 s, instead of every 2 minutes.

`drive.mjs` uses only the Mac CLI, the same steps on both runs:

1. Two followers start with `nexus events --follow --since latest --json`, one with `--kind pull-request.linked` and one with no kind.
2. Two builders start, "Greet by name" and "Greet loudly", and each pushes a branch that opens a PR.
3. Once `nexus show` lists both PRs, the person closes PR #1 on GitHub and reopens it, and the drive waits 8 s more, four more PR watch passes.
4. The followers stop, and `nexus show` and `nexus events` run.

## What was checked

| Capture | main | branch |
|---|---|---|
| `follow-linked.txt` | exit 64: `unknown event kind` | 2 events, exit 0 by Ctrl-C |
| `follow-linked.jsonl` | empty | one `pull-request.linked` per PR, with `repo`, `number`, `url`, `title` and `state` `open` |
| `follow-all.jsonl` | empty: nothing in the stream says a PR opened | the same two events, and nothing for the close, the reopen or the passes after |
| `04-show-byName.txt`, `05-show-loudly.txt` | each PR linked | each PR linked |
| `07-events-all.txt` | no events | events 1 and 2, both `pull-request.linked` |
| `drive.log` | `the pull-request.linked follower never heard of it` | the follower got each event 830 and 836 ms after it was written |
| `tests.txt` | both new tests fail | both pass |

The branch's follower, `follow-linked.jsonl`:

```
{"id":"1","time":1793157469608,"thread":"th-818fdd0718e0","project":"nexus","kind":"pull-request.linked","payload":{"repo":"ramtinJ95/nexus","number":1,"url":"https://github.com/ramtinJ95/nexus/pull/1","title":"Greet by name","state":"open"}}
{"id":"2","time":1793157469614,"thread":"th-93f7b5689564","project":"nexus","kind":"pull-request.linked","payload":{"repo":"ramtinJ95/nexus","number":2,"url":"https://github.com/ramtinJ95/nexus/pull/2","title":"Greet loudly","state":"open"}}
```

The lag of under a second is the event stream's own read, once a second (`followEvents` in `src/control/api.ts`). The event is written by the PR watch's save, so it comes no sooner than the watch's pass, every 2 minutes in production.

## Not verified

- The verify-nexus stack, with Docker pylons and the dashboard. The change has no dashboard surface.
- Real GitHub. The fake answers only the reads the PR watch makes.
- The same transaction under a crash. The registry test shows one event per link, and the code writes both in one `transaction`, but no capture kills the process between them.
