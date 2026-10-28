# Token usage backfill verification

Verified in this task's pylon on 2026-10-28, on branch `feat/token-usage-backfill`, against main at 637e93f, with headless Chromium. No live control plane, node, image or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `probe.ts`, `control.ts` and `drive.mjs` into each, builds the dashboard, and runs `drive.mjs` in each checkout the same way. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`.

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
	docs/verification/token-usage-backfill/run.sh origin/main HEAD
```

The stack runs as two processes, so the driver can restart the control plane alone, as a deploy does:

- `control.ts` is `startControlPlane` from `src/control/main.ts`: the registry, reconcile loop, pi-durable harness, usage counter, backfill, API and dashboard, on plain HTTP at 127.0.0.1:7470. The model is the scripted one, and no thread sends it a message.
- `probe.ts` is the real probe from `src/probe/server.ts` on 127.0.0.1:7480. Only its VM backend is a stand-in:
  - Each pylon is a directory whose `home/` stands for `/home/user`.
  - The usage reader's raw pipe runs as a local process against that directory.
  - A spawn or a pause changes the pylon's `state.json` and writes one line to `pylons.log`. The line says whether a boot from a checkpoint relaunched the recorded sessions, which is what starts a pylon's agent, or left them for the next spawn.
  - A paused pylon holds disk only.
  - Docker is not available in this pylon, so the verify-nexus stack could not run.

The driver starts seven threads in a scratch project through the CLI. It writes the real `src/fixtures/claude-transcript.jsonl` into the first pylon while it runs, then restarts the control plane, whose start reads every running pylon, so that thread is counted live. It archives all seven and deletes one. Then it writes each archived pylon's history onto its paused disk, as history from before counting started:

| Thread | Its pylon's history | Calls |
|---|---|---|
| Counted live before archive | The real Claude transcript, already counted live | 9 |
| Long Claude history | 6,000 Claude calls, each written as two records, and 10 in a subagent's transcript. This passes the reader's 1 MiB a read, so it takes several reads | 6,010 |
| Harness review in pi | The real pi session `src/fixtures/pi-session.jsonl` | 2 |
| Claude and pi, held at boot | 25 Claude calls and 7 pi calls. Its boot is held until the driver restarts the control plane | 32 |
| Pylon fails to boot | 4 Claude calls. Its spawn fails, as infra-testbench's VMs sometimes do | 0 |
| Transcripts fail to read | 3 Claude calls. Its usage reader exits 1 | 0 |
| Deleted before the backfill | 5 Claude calls, gone with its pylon | 0 |

`01-hand-sum.txt` states each history's counts in `drive.mjs` itself, not read from the code under test. The total after a backfill is 6,053 calls and 7,934,207 tokens.

## What was checked

| | main | branch |
|---|---|---|
| Totals before | `03-api-total-before.txt`: the 9 live calls, 332,454 tokens. `03-usage-before.png`: the page says where counting started. | The same total. `03-usage-before.txt` and `.png` add: backfill not run, and a deployer runs `nexus usage backfill`. |
| Dry run | `04-dry-run.txt`: unknown option, exit 64. | `04-dry-run.txt`: the six archived threads, not the deleted one. |
| Room for a person's start | Nothing to compare. | `05-waiting.txt`: another project asks for 5 GiB of the node's 5.8 GiB. The run waits, with the reason, and wakes no pylon until that project is edited down. |
| Running | `06-usage-running.png`: no backfill. | `06-usage-running.png` and `.txt`: "3 of 6 threads read", and the thread whose boot is held. |
| A restart mid-run | Nothing to compare. | `07-restart.txt`: the control plane restarts while the probe holds the fourth pylon's boot. The run, its held pylon and the total are the same after, and the run goes on to the end. |
| Totals after | `08-api-total-after.txt`: still 9 calls, so DIFFERENT from the hand sum. | `08-api-total-after.txt`: MATCH with the hand sum. `08-usage-after.txt` and `09-usage-done.png`: done, 6,044 calls recovered, which is the hand sum less the 9 counted live, and the two skipped threads with their reasons. `09-usage-done-phone.png` is the same at 390 px. |
| Threads left as they were | `10-threads-compare.txt`: unchanged. | `10-threads-compare.txt`: every thread is still archived, its pylon paused and not failed. Its attention, seen mark, last reply and last human activity are unchanged. `10-sessions-after.txt`: each still lists its Claude session as paused. |
| What each pylon did | `11-pylon-lifecycle.txt`: no pylon woke. | `11-pylon-lifecycle.txt`: one pylon at a time, each booted from its checkpoint without relaunching its sessions, read, and paused again keeping its session list. The failed boot was never retried in that run. The pylon whose read failed was paused again. No boot relaunched sessions. |
| A second run | `12-second-run.txt`: unknown command. | `12-second-run-pylons.txt`: only the two skipped threads were woken again. `12-second-run-total.txt`: the total did not change. |

## What this does not prove

- A real pylon-vm or Docker pylon. The backend here is a stand-in that follows `relaunch: false`. The real backends' handling, which keeps the relaunch pending and the paused session list across the boot and its pause, is covered by `src/pylon-vm-backend.test.ts` and `src/docker-backend.test.ts`, not end to end. The pylon-vm boot from a stopped instance with `relaunch: false` has no test, because it needs Gondolin.
- Herdr. These pylons have none. In a real pylon woken for reading, Herdr is not started, so its sessions show as none in the registry until the pause reports them as paused again.
- The live registry: how many archived threads still have readable pylons, and how long infra-testbench's failures take.
