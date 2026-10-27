# Shared helpers verification (issue #139)

Verified in this task's pylon on 2026-10-27, on branch `refactor/shared-helpers`, against main at `7cdf2bf`. No
live control plane, node, image or other thread was touched. Nothing here needs Docker, tailscale or root.

## What runs

`run.sh` checks out two worktrees and runs the same two things in each. "main" is main with only the two pin
commits on top. "branch" is this branch's last commit that changes code.

- `capture.ts` drives the real code and prints what a node, a probe, a deploy or a person can observe of it:
  - the deploy journal and report a `ReleaseInstaller` and `reconcileRole` write, as bytes and mode, and everything
    else left in their directory;
  - the probe's preview routes file under umask 022 and 077, and `readRoutes` of it, of a missing file and of
    malformed ones;
  - a pylon controller file written with `saveJson`;
  - the files `deploy/install-deployer.sh` copies into the bootstrap worker, and that worker's `--check`;
  - the repo files and packages the deploy worker loads, from an esbuild metafile;
  - against a fake `docker` and `tailscale` first on PATH: every argv they get, the probe's tailscale CLI output
    and error text, the Docker double's label filters, error text and guest exec results (exit 0, exit 7, a
    timeout), its services' exit-3 result and a failing checked step, and the host bridge's `docker ps`;
  - the project mirror against a real `file://` git remote: a commit with and without `.nexus/setup`, a missing
    branch's error text, an SSH remote, an abort.
- The 13 test files that hold the pins, with durations cut.

## Captures

- `main.txt` and `branch.txt`, from `capture.ts`. `capture.diff` is their diff. Every changed line is one the
  branch makes on purpose:
  - The deploy journal and report are indented JSON, not compact. Their content and mode 0600 are unchanged.
  - The routes file is mode 0600 under umask 022. Under the probe unit's umask 0077 it was already 0600.
  - The bootstrap copies `src/json-file.ts`, and the deploy worker loads it.
- `tests-main.txt` and `tests-branch.txt`. Main passes 292 of 292 and the branch 293 of 293. Apart from their first
  line they differ only by the branch's test that the routes file is mode 0600 under umask 022, which fails on main
  by design.

## What was not checked

- The temp file names (`<file>.new` and `<file>.tmp` became `<file>.<pid>.tmp`) leave nothing behind on success
  on either side, so the captures cannot show them. The serve test that blocks the write by its temp name was
  updated to the new name.
- The bootstrap worker's `--check` fails on main and on the branch alike: `src/deploy/worker.ts` imports
  `src/protocol.ts` since #146, and `install-deployer.sh` does not copy it. This branch adds no new missing file.
- No real Docker daemon, tailscaled, systemd unit or node install ran.
