# Planning cards

Verified in this task's pylon on 2026-10-28, on branch `feat/planning-cards` against main at 8a94974, with Node 26.12.1 and headless Chromium from `@sparticuz/chromium` 138. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<folder of a fonts.conf listing its fonts> \
  docs/verification/planning-cards/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs `stack.ts drive` there. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same file and the same steps, so the captures differ only by the code under test. Then it runs the branch's planning tests against each checkout's code, into `tests-main.txt` and `tests-branch.txt`. `RUNS=main` or `RUNS=branch` runs one of them.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` is [the pipeline-items stack](../pipeline-items/README.md) with a new driver: the real `startControlPlane` from the checkout under test in one child process, with its registry, loop, harness, PR watch, review loop, queue, pipeline pass, planning pass, API and dashboard, and the real probe server in another, so a restart is a process exit and the registry file survives it. Every command goes through the real `nexus` CLI, and every page through headless Chromium. The stand-ins are tailscaled's whois, which answers the probe as the node and every other caller as the person's laptop, `nVERIFYLAPTOP`, GitHub as an HTTP server in the driver, a VM backend that boots nothing and logs each pylon it is asked to boot to `backend.log`, and the scripted model.

The scripted model is the planning thread. Asked to plan the roadmap's orchestration wave, it answers with a `nexus-plan` block of two items from that section, "Wake the passes from the event stream" and "Ask the person through the attention status", the second after the first, and it echoes the token its message holds, or `"none"` when the message holds none. Any other message gets the repository's scripted answer.

The driver adds project `wave`, turns its pipeline on with `project edit wave --pipeline start`, so an item starts on its own, and then:

1. Starts the planning thread with `start --plan --message <the ask>`. Main has no `--plan`, so its run starts the same thread without it and sends the same message.
2. Waits up to 45 s for two cards, then restarts the control plane, which reads the thread's replies afresh.
3. On the thread's page, presses `accept` on the first card and `reject` on the second, as the person does, accepting each browser confirmation.
4. Waits for an item with a thread, then sends the planning thread one more message.
5. Ticks the start dialog's Planning thread box and starts a second planning thread from the dashboard.

## Main (`main/`) and this branch (`branch/`)

| Step | main, 8a94974 | this branch |
|---|---|---|
| Start, `05-start-plan.txt` | exit 64, `Unknown option '--plan'`. `06-start-plain.txt` starts it without | exit 0, the planning thread |
| The thread's first message, `conversation-plan` | the person's message alone, and the scripted block with token `none` | the guide with the thread's token before the person's message, and the block echoing that token |
| Cards, `show-plan-cards` | none after 45 s, and attention `new reply` | `planning:`, attention `decision`, and two questions with options `"accept"`, `"reject"` |
| Before any answer, `items-before-answers`, `threads-before-answers` | `No pipeline items.`, one thread | `No pipeline items.`, one thread, though the project starts items on its own |
| After the restart, `show-plan-after-restart` | no questions | the same two question IDs, each once |
| The thread page, `01-plan-cards.png` | the block as a reply, no card | both cards, each brief in full, the second saying it waits on the first |
| Pressing `accept`, then `reject` | no card to press | `02-accepted-first.png`, `03-rejected-second.png`, and `show-plan-answered` with `answered "accept" by nVERIFYLAPTOP` and `answered "reject" by nVERIFYLAPTOP` |
| `items-after-answers`, `item-show-accepted` | `No pipeline items.` after 60 s | one item, "Wake the passes from the event stream", added by `nVERIFYLAPTOP`, `building`, on thread `th-ad16b10af5f3` |
| The builder, `conversation-builder`, `backend.log` | no builder | its first message is the accepted brief, and its pylon booted in the same tenth of a second as the browser confirmed the accept. `phases.txt` saw the item go straight to `building`, since the queue started its queued thread on the same pass |
| `threads-after-answers` | only the planning thread | the planning thread and the one builder. The rejected item made no item and no thread |
| The next message, `conversation-plan-after` | the person's text alone | `accepted "Wake the passes from the event stream" (key wake), now pipeline item it-…`, `rejected "Ask the person through the attention status" (key ask)`, then the person's text |
| Dashboard start, `05-start-dialog.png`, `06-dashboard-planning-thread.png`, `show-dashboard-plan` | no Planning thread box | the box under Nexus agent, and the new thread's page and `show` mark it `planning` |
| `tests-*.txt` | the files fail to load, and the nudge test fails | 9 of 9 pass |

The item's thread is the one the pipeline queued under the request ID `pipeline:<item>`, which `item show` reads to name it. The queue starts a queued thread with nothing ahead of it on the pass that queued it, so it was `queued` for less than the watcher's one-second read.

Branch, the planning thread's page with both cards:

![branch, two cards](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/planning-cards/docs/verification/planning-cards/branch/01-plan-cards.png)

Branch, after `accept` on the first card and `reject` on the second:

![branch, both answered](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/planning-cards/docs/verification/planning-cards/branch/03-rejected-second.png)

Branch, the Pipeline page with only the accepted item:

![branch, one item building](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/planning-cards/docs/verification/planning-cards/branch/04-pipeline.png)

Branch, the start dialog with the Planning thread box:

![branch, the start dialog](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/planning-cards/docs/verification/planning-cards/branch/05-start-dialog.png)

Main, the same reply on the same page, with no card:

![main, no card](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/planning-cards/docs/verification/planning-cards/main/01-plan-cards.png)

## Unit tests

`src/control/planning.test.ts` holds the parser and idempotency tests. "A plan block is read only with its thread's token ..." covers the token, the item order, the block hash, and each block that is not read: another token, bad JSON, no items, a key used twice, an item waiting on a later one, and a reference that is neither a key nor an item ID. "A block makes each card once ..." runs two passes at once, reads the block again after a later turn, and reopens the registry file with its read reset as a crash would leave it. Two more cover a send the harness did not take and an item ID that a later proposal uses as its key. "An accepted proposal adds the item ... once" accepts twice and refuses an item after a rejected one. In `api.test.ts`, "a planning thread's proposals become cards only a person answers ..." has the control plane's own node refused with 403 and the phone, a person, accept, and checks that nothing exists before the answers and only the accepted item after. `nudge.test.ts` checks that a planning thread is never nudged.

## What this does not prove

- A real model. The scripted model writes a well-formed block every time. Whether a real model follows the guide, writes complete briefs and revises from the answers is untested.
- A real tailnet's whois. Here every caller but the probe is the laptop, so the dashboard run shows only the person answering. That a pylon or the control plane's node is refused is shown by the API test, not on the stack.
- A pylon VM. Nothing ran in a pylon, so the claim that a harness thread's tools reach only its pylon rests on [the design](../../design.md#who-starts-a-thread), not on this run.
- A project whose pipeline waits for approval. An accepted proposal there waits for `item approve`, as any added item does, and no test drives that path.
