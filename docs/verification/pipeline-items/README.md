# Pipeline items

Verified in this task's pylon on 2026-10-28, on branch `feat/pipeline-items` at 66aa19a against main at b996fb0, with Node 24.22.1 and headless Chromium from `@sparticuz/chromium` 138. No live control plane, node, image, GitHub repository or other thread was touched. The branch was then rebased onto main at 63695a3, which changes only the pylon image, so its commits have new IDs.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<folder of a fonts.conf listing its fonts> \
  docs/verification/pipeline-items/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs `stack.ts drive` there. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same file and the same steps, so the captures differ only by the code under test. Then it runs the branch's nine pipeline tests against each checkout's code, into `tests-main.txt` and `tests-branch.txt`. `RUNS=main` or `RUNS=branch` runs one of them.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` is [the queued-threads stack](../queued-threads/README.md) with a new driver: the real `startControlPlane` from the checkout under test in one child process, with its registry, loop, harness, PR watch, review loop, queue, pipeline pass, API and dashboard, and the real probe server in another, so a restart is a process exit and the registry file survives it. Every command goes through the real `nexus` CLI and every page through headless Chromium. The stand-ins are tailscaled's whois, the scripted model, which answers a message with `scripted answer after user`, GitHub as an HTTP server in the driver, and a VM backend that boots nothing and logs each pylon it is asked to boot to `backend.log`. Its guest answers the probe's git read with the branch the driver says the agent pushed, and runs the pi-env daemon for the harness. It runs nothing else, so `control.log` has the turn snapshots and token-usage reads it refused.

The driver adds project `wave`, turns its pipeline on with `project edit wave --pipeline start`, and adds two items: A, and B after A, each with a brief. Then:

1. It waits for A's thread to start, pushes A's branch and opens PR #1.
2. It restarts the control plane while B waits for A.
3. It waits for the PR watch to link PR #1, then merges it outside any review, and waits for B's thread to start.

A watcher reads `items --all --json` once a second throughout and writes each item's phase to `phases.txt` whenever it changes.

## Main (`main/`) and this branch (`branch/`)

| Step | main, b996fb0 | this branch |
|---|---|---|
| `03-project-edit-pipeline.txt` | exit 64, `Unknown option '--pipeline'` | exit 0, and `04-projects.txt` says `pipeline starts items` |
| `05-item-add-a.txt`, `06-item-add-b.txt` | exit 64, `unknown command item` | exit 0. A is `queued: starts on the queue's next pass`, and B is `queued: waits for A: greet by name: has no pull request yet` |
| `backend.log` | no boots | A's pylon booted at the moment `item add` answered, as the add's own pass queued it and the queue started it. B's booted once, 117 s after PR #1 merged: the PR watch's 2-minute read plus one pass |
| `12-items-after-restart.txt` | exit 64 | after the restart, A `building` and B `queued`, on the same two threads |
| `phases.txt` | empty | A: `building`, `reviewing: PR #1 is open, before its review`, `landed: PR #1 merged`. B: `queued: waits for A ... has no pull request yet`, `... PR #1 is open`, then `building` |
| `14-item-show-b-waiting.txt` | exit 64 | B's phase, thread, worker, the item it is after and its brief |
| `15-conversation-b.txt` | not taken: there is no B | B's brief as its first message, and the scripted answer |
| `17-items-end.txt` | exit 64 | A `landed: PR #1 merged`, B `building: no pull request yet` |
| `/pipeline` | `{"error":"no route /pipeline"}` | the Pipeline page, below |
| `tests-*.txt` | the four test files fail to load, and the registry's migration test fails | 9 of 9 pass |

Main, `/pipeline` while B waits:

![main, no pipeline page](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/pipeline-items/docs/verification/pipeline-items/main/03-pipeline-a-reviewing.png)

Branch, `/pipeline` while A's pull request is open and B waits on it:

![branch, A reviewing and B queued behind it](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/pipeline-items/docs/verification/pipeline-items/branch/03-pipeline-a-reviewing.png)

Branch, `/pipeline` once A's pull request merged and B started:

![branch, A landed and B building](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/pipeline-items/docs/verification/pipeline-items/branch/04-pipeline-b-building.png)

## Unit tests

`src/control/pipeline.test.ts` is the pass test over every phase. "An item moves through every phase its records put it in, from planned to landed" drives two items, the second after the first, through `planned`, `held` for approval, `queued`, `building`, `reviewing` before and during a review, `landing` while approved, merging and deploying, and `landed`, then sees the second start. "An item is held for the person ..." covers each `held`, and "an archived thread, a cancelled queued thread ..." covers `archived`, `cancelled` and a merge outside any review. "An item is queued once across passes and restarts" runs three passes at once and then reopens the registry file. The API, CLI, dashboard and registry tests in `tests-branch.txt` cover the routes, who may approve, the commands, the page and the migration that turns the pipeline on for project `nexus`.

## What this does not prove

- A review that lands its pull request. The merge here is made outside any review, which the PR watch reads, since the stack's project has no auto-review. `pipeline.test.ts` drives an item through a review's phases to `landed`, and the queue already starts a thread whose predecessor's review landed.
- `--pipeline approve` on the stack. The API, CLI and dashboard tests cover approving.
- The migration on the live registry. The registry test runs it on a file with projects `nexus` and `other`.
- A pylon VM, a real model, a Claude worker item and a deploy's drain.
