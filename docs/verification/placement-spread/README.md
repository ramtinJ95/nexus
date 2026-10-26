# Placement spread verification

Verified in this task's pylon on 2026-10-26, on branch `placement-spread`. No live control plane, node or other thread was touched.

## The stack

`stack.ts` runs the real API on `127.0.0.1:7471` over a real registry, with three nodes: `rj-firebat` with 22.8 GiB of memory, and `infra-testbench` and `spare-node` with 31.3 GiB each. `drive.sh` drives it with the real CLI (`node src/cli/nexus.ts` with `NEXUS_URL` and `NEXUS_SOCKS=none`) and writes every capture here.

No probe, loop or VM runs. The stack ingests each node's observation into the registry the way the loop stores a probe's. The harness is the fake one. Its `startThread` waits 2 s before it creates a conversation, so two starts overlap the way they can on the live control plane.

Project `nexus` asks for 4 CPUs, 8 GiB and 40 GiB, and starts with `rj-firebat` as its default node, as every project had. The stack starts seven Claude worker threads pinned to `rj-firebat`, then archives two of them. `rj-firebat`'s observation reports 40 of 22.8 GiB committed. That is four running workers and one orphaned VM the registry does not know, at 8 GiB each. The paused worker and the two archived ones are stopped. `spare-node` reports 4 GiB committed and `infra-testbench` none.

## What it shows

- `version.txt`. The CLI is 0.21.0.
- `nodes.txt` and `nodes.json`. `rj-firebat` is marked `overcommitted` after its memory figure. The line under it reads `4 up holding 16 CPUs and 32 GiB, 1 paused needing 8 GiB to wake, 2 archived, 1 orphaned (pylon-th-0rphan000000)`. The other nodes have no pylons, so they get no `pylons` line. `nodes.json` has the same facts as `overcommitted` and `pylons`.
- `overlap.txt`, `overlap-one.json` and `overlap-two.json`. Two `nexus start --node auto` calls ran at once. Each waited 2 s for its conversation between the choice and the registry write. `overlap two` chose first and saw `infra-testbench` with 23.3 GiB left. `overlap one` saw the room `overlap two` had reserved, so `infra-testbench` showed 15.3 GiB left against `spare-node`'s 19.3, and it went to `spare-node`. Both list `rj-firebat is overcommitted, with 48 of 22.8 GiB of memory committed`. The 48 is the reported 40 plus the paused worker, whose thread has recent human activity, so the planner is about to wake it.
- `start-default.txt`. Before the edit, a start without `--node` went to `rj-firebat`, the project's default, although it is overcommitted (`show.txt`, `before the edit`).
- `project-edit.txt`. `nexus project edit nexus --node auto` succeeded, and `nexus projects` lists `node auto`.
- `start-project-auto.txt`. After the edit, a start without `--node` was placed by `auto` on `infra-testbench` (`show.txt`, `after the edit`).
- `start-pinned.txt`. `--node spare-node` still pins the pylon, with `placement: spare-node, as the start named`.
- `project-add.txt`. `nexus project add spread <url>` without `--node` printed `Added project spread (...) on auto`. With `--json`, it returned `defaultNode: "auto"`. `nexus projects` lists both new projects with `node auto`. Both got 6 GiB of memory, the new default without `--memory`.
- `start-sized.txt` and `show.txt` (`sized`). `nexus start --project nexus --memory 12 --cpus 2` took the project's 40 GiB disk and went to `infra-testbench`, the only node with 12 GiB left, since `spare-node` had 11.3. `show` prints `size: 2 CPUs, 12 GiB memory, 40 GiB disk`, and its placement line weighs the 12 GiB.
- `start-too-big.txt`. `--memory 20` fits no node, so the start is refused with each node's reason, every one weighed against 20 GiB, and exits 5.
- `start-form.txt`. `start-form.mjs` runs the dashboard's built `client.js` in jsdom against the start dialog the stack serves. The CPUs, memory and disk fields show the picked project's size as placeholders and follow the project picked. A submit with memory 12 and CPUs 2 sends `resources: { cpus: 2, memoryGiB: 12 }`, and one with the fields empty sends no `resources`.
- `dashboard.html`. The rendered HTML of the dashboard's home page, fetched from the stack, cut to four parts by `drive.sh`. The start dialog's CPUs, memory and disk fields carry the project's size as placeholders. The side node list shows each node's committed and total memory, `rj-firebat`'s `<em>overcommitted</em>`, and `8 GiB to wake paused`. The start dialog's hint for `nexus`, whose default is now `auto`, reads `Boots a pylon on the node with the most room left`. The new-project dialog's node picker offers `auto, where it fits best` first and selected.
- `threads.json` lists the seven seeded workers and the six threads started above.

Every started pylon shows `absent`, because no probe runs. Placement happens before a pylon boots, and does not depend on it.

## What was not verified

- A real probe's reading. The committed figures here are the stack's numbers, not a measurement. The probe's counting is unchanged since `docs/verification/node-capacity`, which ran real probes over pylon-vm.
- The live fleet. `nexus nodes` against the live control plane needs the tailnet, which this pylon cannot reach.
- The dashboard in a real browser. `dashboard.html` is the server's HTML, and `dashboard.test.ts` checks it. `client.js` ran only in jsdom, for the start form's size fields, and no screenshot was taken.
- The same stack without the reservation. Instead, in `src/control/api.test.ts`, removing the reserved rooms from `weigh` made the overlapping-starts test fail.

## Rerun

```sh
node docs/verification/placement-spread/stack.ts &
sleep 5
sh docs/verification/placement-spread/drive.sh
```

`stack.ts` starts from an empty `/tmp/nexus-spread` each time, so the thread IDs change. `start-form.mjs` needs jsdom, which the repo does not depend on: `NODE_PATH=<dir>/node_modules node docs/verification/placement-spread/start-form.mjs > docs/verification/placement-spread/start-form.txt`, with the stack still up after `drive.sh`.
