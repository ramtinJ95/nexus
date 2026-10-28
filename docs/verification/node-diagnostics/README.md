# Node diagnostics verification

Verified in this thread's pylon on 2026-10-28, on branch `feat/node-diagnostics` against main at `38e8a5f`, with Node 24.22.1 and headless Chromium from `@sparticuz/chromium`. No live control plane, node, image or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts`, `vm-stand-in.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same three files, so the captures differ only by the code under test. Then it runs the branch's host, redaction and log-tail tests into `tests-branch.txt`.

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/node-diagnostics/run.sh origin/main HEAD
```

## The stack

`stack.ts` runs one node, `infra-testbench`: a real probe over a real pylon-vm backend, followed by the real loop, API and dashboard on `127.0.0.1:7470`. The node's secret file holds `GH_TOKEN=nexus-planted-gh-token-4f2a9c71`. Deployers are the laptop. The API also allows a phone, which is not a deployer. This pylon has no KVM, so the backend's boot is the one stand-in:

- A pylon of project `flaky` is left as a controller that failed to boot the VM leaves it: status `failed`, and a `controller.log` that holds the planted value twice, in a git URL and an env line, and ends in `Error: Guest command got no answer within 13000 ms`.
- A pylon of `acme` or `docs` runs the real `src/pylon-vm/daemon.ts` with `vm-stand-in.ts` as its runtime. That is `src/pylon-vm/fake-runtime.ts` with an inspect answer that has the record's labels, and a child process that stands in for QEMU. `acme`'s keeps half a CPU busy and holds 300 MiB.

Everything from the instance directories up is the code under test. `POST /verify/restart` stops the probe, so the node goes away, then restarts the control plane on the same registry file. The fake harness starts empty after the restart, so the thread page shows that it has no conversation for the thread.

## What it shows

| | main | branch |
|---|---|---|
| `nexus show` of the failed pylon | `main/01-show-failed.txt`: `failed: pylon is broken: the controller failed to boot the VM. Read controller.log in the instance directory`, nothing more | `branch/01-show-failed.txt`: the same line, then the log's six lines indented, with `https://[redacted]@github.com/...` and `GH_TOKEN=[redacted]`, ending in the guest timeout |
| The API's thread detail | `main/02-api-thread-detail-pylon.json` | `branch/02-api-thread-detail-pylon.json`: `pylon.failed` carries the lines |
| The thread page | `main/03-thread-page-failure.png` | `branch/03-thread-page-failure.png`, the failure box with the log under the reason |
| The planted value | `main/11-planted-secret-count.txt`: on the node's log 2, elsewhere 0, since nothing leaves | `branch/11-planted-secret-count.txt`: on the node's log 2, in `show`, the API and the page's HTML 0 |
| After the node goes away and the control plane restarts | `main/12-show-after-restart-node-offline.txt` | `branch/12-nodes-after-restart.txt` shows the node offline. `branch/12-show-after-restart-node-offline.txt` and `branch/13-thread-page-after-restart.png` still show the lines |
| `nexus node infra-testbench` | `main/05-nexus-node.txt`: `unknown command node`, exit 64 | `branch/05-nexus-node.txt` and `06-nexus-node.json`: load, 4 CPUs, memory, no swap, disk at the state root, temperatures unknown, and both running pylons, `acme`'s at about 49% CPU and 0.5 GiB |
| The dashboard | `main/07-sidebar-nodes.txt`: the node has no link. `/nodes/infra-testbench` is a 404 | `branch/07-sidebar-nodes.txt` links `/nodes/infra-testbench`. `branch/08-node-page.png` and `09-node-page-phone-width.png` show its health and pylons, each linked to its thread |
| A caller that is not a deployer | | `branch/10-node-page-not-deployer.png` and `10-nexus-node-not-deployer.txt`: refused, exit 3 |
| A node that does not answer | | `branch/14-nexus-node-unreachable.txt`: `connect ECONNREFUSED`, exit 1 |

This pylon's VM exposes no hwmon or thermal zone, so `temperatures: unknown` is what a host without sensors reports. `src/probe/host.test.ts` parses `/proc/loadavg`, `/proc/meminfo`, a process's `stat` and `status`, hwmon and thermal zones from the fixture trees in `src/fixtures/host/`.

## What was not verified

- A real node. The hwmon fixture is written to the kernel's sysfs format, not copied from `rj-firebat` or `infra-testbench`, so their sensor names and which sensors they expose are unchecked.
- A real controller's crash. The log is scripted, so whether the controller's real output around a guest timeout holds a secret shape the redaction misses is unchecked.
- QEMU's process tree. The stand-in is one child process. A real controller's QEMU and its threads are counted the same way through `/proc`, but no VM ran here.
- The Docker backend, which names no pylon processes, so its `pylons` is null. The verify-nexus stack needs Docker, which this pylon lacks.
