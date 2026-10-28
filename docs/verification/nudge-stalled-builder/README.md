# Nudge a builder that stopped short of a pull request

Verified in this task's pylon on 2026-10-28, on branch `feat/nudge-stalled-builder` at ea09148 (code and docs; the capture's own commit follows it), against main at 716a624, with headless Chromium 138. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
docs/verification/nudge-stalled-builder/run.sh origin/main HEAD
# with screenshots:
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023/lib> FONTCONFIG_PATH=<its fonts> \
  docs/verification/nudge-stalled-builder/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test. Then it runs the branch's `src/control/nudge.test.ts` against each run's code, into `tests.txt`.

`stack.ts` runs the real registry, API, dashboard, PR watch, inbox and, where the checkout has it, the nudge pass, wired as `src/control/main.ts` wires them, with the real `githubClient`. Docker is not available in this pylon, so the verify-nexus stack could not run, and no real Claude Code ran. GitHub is a fetch handler that keeps the PRs and logs each search in `github.log`. Builders are Claude workers with no Claude Code. Each answers every message typed into it with a reply and a turn end, written as a transcript read would be, and its prompt says what it does. The PR watch polls every 2 minutes, as on the control plane. The nudge pass runs every second with a 2 s grace, instead of every 15 s with a minute's grace.

`drive.mjs` uses only the Mac CLI and the dashboard, the same steps on both runs:

1. `project edit nexus --auto-review review`.
2. Four Claude workers start: "Greet by name" stops before pushing, and pushes when nudged. "Greet loudly" stops before pushing and never pushes. "Greet quietly" pushes and opens its PR as its first turn ends. "Explain the queue" answers and never pushes.
3. Once "Explain the queue" has a nudge, the person sends it `Thanks. This one needs no pull request. Which file holds the queue?` with `nexus send`.
4. The drive waits for the PR watch's second pass, then runs `show` on each thread, `threads` and `events --kind attention.changed`, and takes the screenshots.

## What was checked

| Thread | main | branch |
|---|---|---|
| "Greet by name", told to stop before pushing | no nudge, no PR, attention `reply` | one nudge, then it pushed: `show` lists PR #2 |
| "Greet loudly", told to stop and stay stopped | no nudge, attention `reply` | two nudges, then attention `decision`, `needs your decision` on the dashboard, and no third message |
| "Greet quietly", PR opened as its turn ended | no nudge, PR #1 linked | no nudge: the pass searched `greet-quiet` once, found PR #1 and sent nothing, two minutes before the PR watch linked it |
| "Explain the queue", the person writes to it | no nudge | two nudges before the person's message arrived, then nothing more, and no `decision`, though its next turn opened no PR either |
| `tests.txt` | `nudge.test.ts` fails: `src/control/nudge.ts` does not exist | 12 of 12 pass |

The branch's `github.log` shows one search per stalled turn, and the PR watch's own searches two minutes later:

```
04:24:51.455Z th-e2c0dfc37c8f pushed greet-quiet, opening PR #1
04:24:53.459Z searched greet-quiet (state all)
04:24:53.957Z th-336270703db8 pushed greet-name, opening PR #2
04:24:56.454Z searched greet-name (state all)
04:26:50.450Z searched greet-name (state open)
04:26:50.454Z searched greet-quiet (state open)
```

The first capture of this branch searched on every pass, once a second in the stack, until the PR watch linked the PR. The fix records the turn as judged, which the capture above shows. `typed.log` holds every message typed into each worker. `13-events-attention.txt` has `"decision"` for "Greet loudly" only.

Main, "Greet loudly":

![main, the builder stopped and nothing happened](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/nudge-stalled-builder/docs/verification/nudge-stalled-builder/main/02-loudly.png)

Branch, "Greet loudly":

![branch, two nudges, then needs your decision](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/nudge-stalled-builder/docs/verification/nudge-stalled-builder/branch/02-loudly.png)

Branch, the thread list, with "Greet loudly" the only red row:

![branch, the thread list](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/nudge-stalled-builder/docs/verification/nudge-stalled-builder/branch/01-home.png)

## Not verified

- A real Claude worker told to stop before pushing, on the verify-nexus stack. Docker is not available in this pylon. The scripted worker shows what the control plane sends and records, not how a model answers a nudge.
- A harness builder end to end. `nudge.test.ts` covers one on the fake harness: its nudge arrives as a `nexus.nudge` entry, and a person's message after its first reply leaves it alone.
- The minute's grace against real probe reports and GitHub's search. The stack uses 2 s, and its pushes reach the registry at once.
- `src/control/main.ts`'s wiring. The stack wires the same options itself.
- The Changes tab's `probe.stream is not a function` comes from the stack's probe stand-in, on both runs.
