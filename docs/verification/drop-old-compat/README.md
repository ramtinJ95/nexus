# Dropping old compatibility paths

Issue #135 removes three paths that only peers older than every deployment needed:

- the CLI's attach settings retired in 0.9.0, `"ssh"` and `"attach"` in the config file and `NEXUS_ATTACH`,
- the `pty: null` key the control plane sent in each stream request, for probes from before raw-pipe streams,
- and `intent.json` in the shape from before setup was recorded on the pylon's disk (`fresh`, `setupError`), with
  `setupState`'s path that marked such a disk, and `src/pylon-vm-legacy-on-node.ts`, the by-hand node check for it.

Nothing a person, client or node sees changes, except for those older inputs, which the captures below list.

## How to rerun

```sh
docs/verification/drop-old-compat/run.sh origin/main <pins-commit> HEAD 82a703f
```

`run.sh` checks out main, the branch, the pins commit and 82a703f, the release the control plane and both probes
run, into worktrees, and removes them when it ends. It copies this directory's scripts into main's and the
branch's worktrees and runs them there, so the two runs differ only by the code under test.

- `capture.ts` runs the real CLI as a child process with seven config files, with and without `NEXUS_ATTACH`, and
  records the exit code and stderr of `projects` against a closed port and of `attach` without a terminal. It
  records the request a real `ProbeClient.stream` sends to a stub probe that answers 409, and what that checkout's
  `parseStreamRequest` makes of it. It runs the real `daemon.ts` over `fake-runtime.ts` for five `intent.json`
  files and records whether the controller serves, its exit code, the files left and its stderr without stack
  frames. It writes `main.txt` and `branch.txt`, and `capture.diff` is their diff.
- `setup-equivalence.ts` runs on main only, since the branch deletes `setupState`. For both intents the branch
  still reads, from a disk with each of five markers and from no disk, it checks that main's `setupState` returns
  `{ done: setupOnDisk(marker, record), mark: false }`, which is what the branch's boot computes. It writes
  `equivalence.txt`: 12 cases equal.
- `deployed-probe.ts` parses each stream request the branch sent with 82a703f's `parseStreamRequest`, the function
  the probe's server calls before it upgrades a stream. It writes `deployed-probe.txt`.
- The pin tests run on the pins commit, which is main's code with only the pin tests added, into
  `tests-pins.txt`, and on the branch into `tests-branch.txt`. Each run has 153 tests and all pass.

## What the captures show

`capture.diff` holds 102 changed lines. Every one comes from an input that only an older peer sends:

| input | main | branch |
|---|---|---|
| `NEXUS_ATTACH` set, then `attach` | stderr names `NEXUS_ATTACH`, then attach runs | attach runs, nothing more on stderr |
| config with `"ssh"` or `"attach"`, any command | runs; `attach` names the keys on stderr | exit 64, `cli.json is not a CLI config: ✖ Unrecognized key(s): …`, as any unknown key already did |
| any stream request | `{"pty":null,"argv":[…]}` | `{"argv":[…]}`, parsed to the same `{pylonId, argv}` |
| `intent.json` with `fresh` or `setupError` | the controller boots (with the real runtime, `fresh: false` counts as a setup that ran, and the boot marks the disk) | the controller exits 1 with a ZodError `Unrecognized key: "fresh"`, before it serves, so the pylon fails to boot |
| `intent.json` that is malformed, `{"prepare":"yes"}` | exit 1, a ZodError of the two-shape union | exit 1, a ZodError of the one shape |

Every other line is the same: each command with no config, `{}`, `url` and `socks`, or an unknown key; the stream
route, its headers, its 409 and what the probe parses; and a controller over `{"prepare":false}`.

`deployed-probe.txt` shows 82a703f parsing the branch's requests to the same `{pylonId, argv}`, so every node
serves them.

The pin tests differ only by the tests this branch replaces:

| main | branch |
|---|---|
| a config that still holds the ssh attach settings runs every command, and attach names them once | the attach settings retired in 0.9.0 are unknown keys of the config file, and NEXUS_ATTACH is not read |
| an instance whose intent predates the disk marker boots as its intent said, and its disk is marked | an intent written before setup was recorded on the disk is refused |

## What this does not show

These runs use Node 24.22.1, since Node 26 does not run in the pylon this was made in. Nothing here boots a real
VM: the boot's setup decision is shown equal by `setup-equivalence.ts` on main's own functions, not by booting a
pylon on both. Nothing here reads the live nodes, the person's environment or their pylons. That a pylon from
before 2026-10-23 may stop booting is the person's decision, not something these runs checked.
