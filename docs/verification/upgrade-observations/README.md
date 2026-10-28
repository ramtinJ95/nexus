# Upgrading older probes' observations once

Issue #133 moves every reader's handling of older probes into `upgradeObservation` in `src/protocol.ts`. Parsing a
snapshot or pylon event runs it, and so does every registry read. The branch also retires `claudeLaunchRepeatable` and
fails a deleted thread's cut-off Claude launch, which on main stayed `starting`.

## How to rerun

```sh
docs/verification/upgrade-observations/run.sh origin/main <pins-commit> HEAD 82a703f
```

`run.sh` checks out main, the branch, the pins commit and 82a703f, the release every node runs, into worktrees. It
removes them when it ends. It copies this directory's scripts into each worktree and runs them there, so the runs
differ only in the code under test.

- `capture-probe.ts` runs each checkout's real `src/probe/main.ts` on loopback, with `stub-tailnet.ts` in place of
  tailscaled. It writes the first snapshot frame: `probe-deployed.json`, `probe-main.json` and `probe-branch.json`.
  `probe-frames.diff` is main's frame against the branch's, with times, IDs and free disk masked.
- `capture.ts` runs the real API, dashboard, planner (`tick`), preview allocation and ChatGPT token handoff. It runs
  each against the three real frames and against seven observation shapes, one for each probe generation. It reads
  each shape two ways, as a frame the checkout parses and ingests and as a row an older control plane stored. Then it
  prints what a person, a client or a node can observe: the `nodes` row on disk, `GET /v1/nodes`, the detail of a
  running, a stopped and a broken pylon's thread, `POST /v1/threads` with node `auto`, the dashboard's side nodes,
  the job the planner sends each pylon, preview ports, the token handoff, and the writes of the node's next snapshot.
  It writes `main.txt` and `branch.txt`, and `capture.diff` is their diff.
- The pin tests ran on the pins commit, which is main's code with only the pin tests added, and on the branch. Each
  run covers the eight test files this change touches, then the full suite. `tests-pins.txt` and `tests-branch.txt`
  hold the results, and `tests.diff` is the names of the tests that passed in each. Both full suites ran 1273 tests,
  and all passed.

## What the captures show

The release every node runs sends the same frame as main (`probe-deployed.json`, `probe-main.json`). The branch's
probe sends the same frame without `"claudeLaunchRepeatable": true` (`probe-frames.diff`).

Every case a control plane meets today reads the same on main and on the branch. That covers the three real frames,
both probe shapes that send every field, and every registry row an older probe left. `capture.diff` holds 38 changed
lines, all in these cases:

| case | main | branch |
|---|---|---|
| a frame from a probe before held secrets, which no node runs | stored as sent | stored with `"heldSecrets":[]`, which reads the same |
| a frame from a probe before pylons were counted, or older, which no node runs | `nodes.capacity` and `GET /v1/nodes` hold the partial capacity | both hold `null`, and `nexus nodes` prints no capacity for the node until its next snapshot |
| a row stored with a broken pylon that has no cause, by a control plane older than causes | the pylon's cause reads as missing | it reads as `unknown`, as main already reads such a frame, so the thread detail and the planner name the upgrade |
| grants with no committed disk, which no probe sent | weighed on its partial capacity | refused as a probe too old to report what its pylons hold |

## What changed per copy

| copy | how it differed | what the merged one does |
|---|---|---|
| `parseProbeEvent`: `previewRoutes ??= null`, `grants ??= null` | set two fields to null at parse | `upgradeObservation` sets every field an older probe left out, at parse |
| `registry.observationOf`: `grants ?? null` | patched one field again on read, and nothing else | runs the same `upgradeObservation` |
| `parsePylonObservation`: listening, session states, paused sessions, broken cause | upgraded at parse only, so stored rows kept older shapes | `upgradePylon`, run by the same upgrade, at parse and on read |
| `api.ts` `portsOf`: `listening ?? null`, `reconcile.ts` `sessionsOf`: `sessions ?? null` | re-guarded rows stored before the parse upgraded them | read the field as typed |
| `loop.ts`, `tick.ts`, `registry.ts` `previewRoutes?.` and `?? []`, `tick.ts` `grants?.` | read null routes as none and null grants as no secrets | the upgrade gives `[]` and empty grants, and the readers drop the guard |
| `placement.ts` `grants === null`, `grants!`, `heldSecrets?.` | told a probe from before counting apart by its missing grants | refuses on a null capacity, with the same text |
| `chatgpt-token.ts` `heldSecrets?.`, `grants?.` | read missing fields as none | reads `[]` |
| "no `committedDiskGiB` means an old probe": `placement.ts` `overcommitted`, `dashboard.ts` `memoryLine`, `cli/nexus.ts` `capacityText` | three derivations | `countedCapacity` in `protocol.ts` serves the first two and the upgrade. The CLI keeps its own, because it reads the API's reply, which still sends the capacity as reported (`docs/cli.md`). |
| `claudeLaunchRepeatable`: probe sent `true`, `loop.ts` checked it twice | always true on every node | gone. A launch goes again to whichever probe comes back. `retrySafe` is a function of the command. |

## What this does not show

These runs use Node 24.22.1, since Node 26 does not run in the pylon this was made in. Nothing here boots a VM or
reads the live control plane, the nodes or their registries. The captures cannot show that no registry row from a
probe before pylons were counted exists. A row like that reads the same on both sides, as the stored cases show.
Nothing here tests a control plane on main reading the branch's probe. That happens only if a person rolls the
control plane back by hand after the probes upgrade. Such a control plane fails a cut-off Claude launch instead of
sending it again.
