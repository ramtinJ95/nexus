# Token usage verification

Verified in this task's pylon on 2026-10-27, on branch `feat/token-usage`, against main at bdc7fb0, with headless Chromium 143. No live control plane, node, image or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, and runs each checkout the same way. It starts the stack, drives phase 1, stops the stack, starts it again on the same registry and harness storage, and drives phase 2. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt` and the stack's own output in `stack-1.out` and `stack-2.out`.

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
	docs/verification/token-usage/run.sh origin/main HEAD
```

`stack.ts` runs the real registry, pi-durable harness, API, dashboard and usage counter, wired as `src/control/main.ts` wires them, on plain HTTP at 127.0.0.1:7470. Docker is not available in this pylon, so the verify-nexus stack could not run. Only what a pylon cannot host is a stand-in:

- The model is the scripted model of `src/harness/test-fixture.ts`. On the branch, each of its answers reports 1,234 input, 56 output, 890 cache-write and 7,000 cache-read tokens.
- Each pylon is a directory that stands for its `/home/user`. Its probe runs only the usage reader, as a local process, with the paths it is sent under `/home/user/` pointed at that directory (`probe.log`). A deleted thread's directory is removed, as its pylon's disk goes.

The stack's first start creates three threads through the real thread starter:

| Thread | Started by | What it spends |
|---|---|---|
| Fix the flaky queue test | a person | Two answers of the Nexus agent |
| Build the usage page | a person, as a Claude worker | Its pylon holds `src/fixtures/claude-transcript.jsonl` as the worker's transcript, and `src/fixtures/pi-session.jsonl` as a harness reviewer's pi session in the same pylon |
| Review of #160: Count tokens | the review loop, in project `spoon` | One answer of the Nexus agent |

The Claude transcript is a real Claude Code transcript. The pi session is a real pi 1.4.0 session on `gpt-6-astra` made for this check, with two answers.

## The hand sum

| Source | Calls | Input | Output | Cache write | Cache read |
|---|---|---|---|---|---|
| Claude transcript: 9 messages, several written as two or three records | 9 | 20 | 1,523 | 37,665 | 293,246 |
| pi session: (1,723, 5, 0, 0) and (204, 5, 0, 1,536) | 2 | 1,927 | 10 | 0 | 1,536 |
| 3 scripted answers of 1,234, 56, 890 and 7,000 | 3 | 3,702 | 168 | 2,670 | 21,000 |
| Sum | 14 | 5,649 | 1,701 | 40,335 | 315,782 |

The total is 5,649 + 1,701 + 40,335 + 315,782 = 363,467 tokens. `branch/01-hand-sum.txt` prints the same sum from `drive.mjs`, which states the counts on its own and does not read them from the code under test.

## What was checked

| | main | branch |
|---|---|---|
| `nexus usage` | `main/02-cli-usage*.txt`: unknown command, exit 64. | `branch/02-cli-usage.txt`: 14 calls and 363k tokens, by model, project, agent, role and UTC day. `-json.txt` is the report, `-by-model.txt` one breakdown. |
| The totals against the hand sum | `main/03-api-total.txt`: `GET /v1/usage` answers 404. | `branch/03-api-total.txt`: the API's total matches the hand sum. `04-page-totals.txt`: the Usage page's totals row, read from its `data-tokens` attributes, matches it too. |
| The Usage page | `main/04-usage-all.png`: `no route /usage`. | `branch/04-usage-all.png` for all time, `05-usage-today.png` for today, which leaves out the Claude transcript's calls of 2026-10-25, and `06-home-nav.png` for the sidebar's Usage link. |
| A thread's own totals | `main/07-thread-claude.png`: the Pylon pane has no tokens. | `branch/07-thread-claude.png`: 336k, the Claude transcript's 332,454 and the pi session's 3,473. |
| The same transcript read again | Nothing to compare. | `branch/08-reread.txt`: the stack appended the transcript to itself and reported its turn's end, the counter read it, and the total did not change. |
| A control-plane restart | Nothing to compare. | `branch/09-restart.txt`: after the stack stopped and started again on the same files, the total did not change. |
| Deleting the thread | Nothing to compare. | `branch/10-delete.txt`: `nexus delete` of the Claude worker thread, whose pylon directory went with it, left the total unchanged. `11-usage-after-restart-and-delete.png` shows the same page, and `12-usage-project-spoon.png` one project. |
| Phone width | `main/13-usage-phone.png`: `no route /usage`. | `branch/13-usage-phone.png`: the 7-day page at 390 px, with the cache columns hidden. |

## What this does not prove

- A real pylon. The usage reader ran as a local process against a directory, not in a guest over the probe's pipe. The pipe itself is the one the Claude transcript reader already uses.
- A real Claude worker's hook events. The stack reports a `session.turn-ended` event itself, as the worker's Stop hook does.
- A real model's answers through pi-durable. The scripted model stands in, and `src/harness/host.test.ts` reads the same entries from a real harness storage file, a deleted thread's included.
- The backfill on the live registry: how many of today's threads still have readable transcripts, and how far back the live harness storage goes.
