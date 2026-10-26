# Claude turn snapshots verification

Verified in this task's pylon on 2026-10-26, on branch `claude-turn-snapshots`, with
Claude Code 2.1.308 and Herdr 0.9.5. No live control plane, node, image or other thread
was touched.

## The stack

`stack.ts` is the stack from [the Claude thread streaming verification](../claude-thread-streaming/README.md),
on ports 7472 and 7490 under `/tmp/nexus-turn-verify`: the real registry, API and
dashboard, a node whose probe runs commands through the real `runCommand` and pipes as
local processes, and a real Claude Code worker launched and messaged by the real
`sessions.ts` code. Two things differ.

- The Claude hooks are this branch's `images/pylon/nexus-claude-hook`, `nexus-heartbeat.ts`
  and `nexus-turn.ts`, staged with the image's two paths moved the way the stack moves the
  pylon: the checkout, and the image's copy of the checkout helper, which is
  `src/checkout-files.py`. With `HOOKS=old` the hooks are this pylon's own
  `/usr/local/bin/nexus-claude-hook`, the current image's, which takes no snapshot.
- The bridge numbers its events from the clock, so a restarted stack's reports are not
  taken for replays of the last run's.

The CLI is `node src/cli/nexus.ts` with `NEXUS_URL=http://127.0.0.1:7472` and
`NEXUS_SOCKS=none`. `drive.mjs` drives the dashboard in headless Chromium.

## What was checked

- `cli-start.txt`, `turn-1.txt`. `nexus start --claude` launched a worker whose first
  turn added `one.txt` and a line to `README.md`. `--turn` lists exactly those two
  files, and its diff is theirs. `refs/nexus/turn` is a parentless commit whose message
  names the session and the `at` of the thread's first `session.turn-started`. HEAD and
  the branch did not move, and the work is still uncommitted.
- `cli-send.txt`, `turn-2.txt`. A second turn, sent with `nexus send`, added `two.txt` and
  edited `one.txt`. `--turn` lists only those two, against a new snapshot named by the
  second turn start. `--uncommitted` lists all three files for contrast.
- `other-turn-refused.txt`. With `refs/nexus/turn` replaced by a snapshot taken for another
  session, `--turn` fails with exit code 1 and the existing no-snapshot message, instead of
  showing that snapshot's changes.
- `old-hook.txt`. With the current image's hook, a thread's second turn reported its
  `session.turn-started`, and both `changes --turn` and `diff --turn` fail with exit code 1
  and the existing no-snapshot message. No `refs/nexus/turn` exists. This is what a Claude
  thread shows after `nexus deploy` and before the new image is current.
- `01-latest-turn.png`, `02-old-hook-refused.png`, `drive.log`. The dashboard's Latest turn
  on the first thread after a fourth turn lists only that turn's `five.txt` and `six.txt`,
  with `five.txt`'s diff against the turn start. On the old-hook thread it shows the
  refusal.
- A third turn on the first thread ran while the stack had rewritten the hooks to the old
  one, and Claude Code picked up the change: that turn took no snapshot and `--turn`
  refused. The fourth turn, after the stack went back to the new hook, snapshotted again.

- The hook's input paths, by hand on a scratch repository with the staged hook. A prompt
  over the hook's 64 KiB input cap, and input that is not JSON, report no turn start, and
  their snapshot is named `claude:unknown:<at>`, so the previous turn's snapshot no longer
  passes for the latest turn. A heartbeat leaves the snapshot alone.

## Timing

Measured in this pylon, five runs each. `snapshotTurn` took 27 to 29 ms on the stack's
checkout and 47 to 49 ms on a clone of this repository (494 tracked files). The whole
hook, with a `session.turn-started` payload, took 129 to 142 ms, most of it Node's start.
The hook kills the snapshot at 1.5 s, and Claude kills a hook at 2 s.

## Not verified

- The image itself. No image was built, so the Dockerfile's two new `COPY` lines and the
  new smoke check, which runs the image's hook module against a fresh repository, have not
  run. The hook here ran from a staged copy.
- A real pylon on a node, through the real probe and host bridge.
- A snapshot on a large checkout near the 1.5 s deadline. A snapshot cut off by the
  deadline is covered by `src/checkout-files.test.ts`.
