# Failure judgments

Verified in this task's pylon on 2026-10-28, on branch `feat/judgment-threads` against main at 8a94974, with Node 26.12.1 and headless Chromium from `@sparticuz/chromium` 138. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<folder of a fonts.conf listing its fonts> \
  docs/verification/judgment-threads/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs `stack.ts drive` there. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same file and the same steps, so the captures differ only by the code under test. Then it runs the branch's judgment and harness host tests against each checkout, into `tests-main.txt` and `tests-branch.txt`. `RUNS=main` or `RUNS=branch` runs one of them.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` follows [the pipeline items stack](../pipeline-items/README.md): the real `startControlPlane` from the checkout under test in one child process, and the real probe server for each of two nodes, `node-a` on 127.0.0.1 and `node-b` on 127.0.0.2, in two more. Every command goes through the real `nexus` CLI and every page through headless Chromium. The stand-ins are tailscaled's whois, the scripted model, GitHub, which has no pull requests, and a VM backend that boots nothing. Once the driver writes lines to `<run>/break/<pylon>`, the backend reports that pylon broken by its controller, with those lines as the controller log's tail, as the pylon VM backend reports a crashed controller. A pause of the broken pylon settles it onto a checkpoint, and the next spawn resumes from it. `backend.log` has every boot and pause.

The scripted model (`src/harness/test-fixture.ts`) answers a judgment's brief by the marker `judge: <answer>` that the planted log ends with: `judge: retry` gives a valid `retry` block that echoes the brief's token, and `judge: malformed` gives a block with broken JSON.

The driver adds project `wave` on `node-a`, turns its pipeline on, and then:

1. Starts thread A, waits until its pylon runs, and breaks it with a log ending in `judge: retry`.
2. Starts thread B, breaks it the same way with `judge: malformed`, waits for the question card, and presses Retry on it in the browser, accepting the confirmation.

A watcher reads `show --json` of both threads twice a second and writes each change of pylon state, attention and judgments to `judgments.txt`.

## Main (`main/`) and this branch (`branch/`)

| | main, 8a94974 | this branch |
|---|---|---|
| A: `06-show-a-judged.txt` | `failed: pylon is broken ...` with the log, and nothing else. The pylon stays failed | `attention: none`, the pylon running, and `judgment of failure 1 on node-a: retry, by the judgment: ...` then `retried the pylon on node-a` |
| A: `backend.log` | one boot | a pause of the broken pylon onto `ckpt-...-1`, and a boot from that checkpoint, 30 s after the failure was recorded |
| A: `08-show-a-json.txt` | no `judgments` field | one judgment whose `brief` holds the failure with the controller log's tail, the node's health read through its probe (load, memory, swap, disk; this host reports no temperatures), `node-b` weighed and refused for this project, the retries left, and what each answer would do. Its `reply` is the scripted block |
| B: `10-show-b-asked.txt` | the failure, nothing else | `question judgment:4` with options `"Retry", "Leave it failed"`, and `person, by the control plane: the judgment's reply had no valid nexus-judgment block with its token` |
| B: `11-show-b-end.txt` | the same failure | the question answered `"Retry"` by the laptop, `retried the pylon on node-a, as the person answered`, and the pylon running |
| `judgments.txt` | each pylon `failed` for good, `judgments []` | A: `judging`, then `done`. B: `judging`, `acting`, `asked`, then `done` once the card is answered |
| `tests-*.txt` | the test files do not load | 12 of 12 pass |

"Retry on another node" is not on B's card, because `node-a` still lists the broken pylon and Nexus has no job that moves a disk. The brief says the same of `retry-elsewhere`. The red error in the Changes panel of A's page comes from the stand-in guest, which runs nothing but the pi-env daemon.

Main, thread B's page after its pylon failed:

![main, the failure box only](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/judgment-threads/docs/verification/judgment-threads/main/02-thread-b-card.png)

Branch, thread A's page after its judgment retried the pylon:

![branch, the judgment card says retry and what Nexus did](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/judgment-threads/docs/verification/judgment-threads/branch/01-thread-a.png)

Branch, thread B's page with the malformed judgment's card and the question:

![branch, the judgment card and the question card](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/judgment-threads/docs/verification/judgment-threads/branch/02-thread-b-card.png)

Branch, thread B's page once the person answered Retry:

![branch, the answered question and the retried pylon](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/judgment-threads/docs/verification/judgment-threads/branch/03-thread-b-answered.png)

## Unit tests

`src/control/judgment.test.ts` runs the real harness host with the scripted model and a real registry file. It covers each answer (retry, retry on another node, and the move refused while the old node lists the pylon or holds a checkpoint), the person's answer to each option, a malformed and a missing block, a conversation offered no tools whose environment factory is never called, a crash between the brief and its answer that ends in one judgment, one brief and one action after a reopen, concurrent passes and a reopen that judge one failure once, the retry cap, and the failures, projects and threads that are never judged. `src/harness/host.test.ts` covers the judgment conversation across a reopen. The full suite passes, 1468 of 1468.

## What this does not prove

- A real model's judgment. The scripted model only echoes a marker, so whether a real model reads a controller log well is unchecked.
- A real controller crash and a real pylon VM retry or move. The broken pylon and its pause are the stand-in backend's. Only a real node can show that a retried broken VM comes back from its checkpoint, and that a moved pylon boots fresh on the other node.
- Retry on another node on the stack. The stand-in reports every broken pylon as listed by its node, so the move is refused here, as it would be for any crashed controller. The unit tests move a pylon whose node no longer lists it.
- The node health of a pylon VM backend, which names running pylons' processes. The stand-in backend names none, so the brief says `running pylons not reported`.
