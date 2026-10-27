# Zombie processes in pylons

Verified in this task's pylon on 2026-10-27, on branch `fix/pylon-zombie-reaping`. No image was built or rolled out, and no live control plane, node or other thread was touched.

## Where the zombies come from

PID 1 in a pylon is Gondolin's sandboxd. It waits only for the pids of the commands it execs (`waitpid(pid, …)` in `sandboxd/main.zig`), so every process orphaned to PID 1 stays a zombie. Herdr's tree runs under `tini -s`, so nothing under it reaches PID 1. Three things outside that tree orphan processes. `live-pylon.txt` lists what this pylon held about 30 minutes after it booted.

- **Each guest command's worker, about 97% of the zombies.** `GuestProcesses.launch` (`src/pylon-vm/processes.ts`) execs a launcher that starts `worker.py` in a new session and exits. The worker is orphaned to PID 1 and becomes a zombie when its command ends. One was caught alive under PID 1 running the probe's `cat /proc/net/tcp`, and later was a zombie. This pylon had 607 of these `python3` zombies.
- **sshd sessions.** The `user@notty` half of a session outlives its `[priv]` monitor and is orphaned to PID 1. There were 19 of these.
- **The outbox sender that the boot path starts with `setsid -f`.** It is most likely the one `MainThread` zombie. That zombie is owned by user and dates from the boot, and the sender is the only user process the boot path starts, but a zombie keeps no command line to confirm it.

## What makes the count grow

The workers belong to the guest commands that the probe and the control plane run: the listening-port read, the outputs listing, file reads, Herdr snapshots and git facts (`guest-commands.txt`). `growth.txt` counts the zombies under PID 1.

| Window | python3 zombies added | Guest commands sampled |
| --- | --- | --- |
| Idle, 180 s | 37, about 12 a minute | 10 in 60 s |
| One `npm test`, 192 s | 116, about 36 a minute | 67 in 150 s |

The suite runs under Herdr's tini, so its own orphans are reaped. It makes the count grow faster because the probe runs more guest commands during the run, 67 in 150 s against 10 in 60 s idle. Why the probe runs more of them then was not traced. This pylon's rate would reach the builder's 5000 zombies in about 7 hours idle, or in a little over 2 hours of test runs. The commands were sampled from `ps` every 50 ms, so a command shorter than that could be missed.

## The fix

`images/pylon/rootfs-init-extra.sh` now ends with `trap '' PIPE` and `exec /usr/bin/tini -- /usr/bin/sandboxd`. Gondolin inserts this file just before its own `exec /usr/bin/sandboxd` (`injectBeforeSandboxdExec`), so tini becomes PID 1 and sandboxd runs as its child. tini as PID 1 reaps every orphan in the guest. The splice was run with Gondolin 0.13.0's own `injectBeforeSandboxdExec` and `ROOTFS_INIT_SCRIPT`, and `sh -n` accepts the resulting `/init`.

The trap is there because sandboxd sets no SIGPIPE disposition. As PID 1 it never needed one, because the kernel does not deliver a signal to init that init has no handler for. As tini's child, a write to an exec's closed stdin kills sandboxd, then tini, then the guest. The review of this change found this. sandboxd's execs inherit the ignore. Every guest command that the probe and the control plane send to a running pylon runs through Python (`src/pylon-vm/guest.ts`), and Python's `subprocess` restores SIGPIPE for the commands it starts, so those commands see no change. The execs that skip Python are the image smoke checks, Gondolin's SSH setup script, its file helpers and its shutdown `sync`. sshd ignores SIGPIPE itself, as its listener in this pylon shows (`SigIgn 0x1002`), and the second review reports that it restores the default before it runs a session's command. Neither review found a regression in the others.

## The checks

The image smoke boot gets two checks:

- "PID 1 reaps orphans". A plain exec orphans a `sleep 0` to PID 1, and the check expects PID 1 to be tini and the sleep to be gone a second later.
- A write to the stdin of an exec that closed it. The check expects that exec to exit 0 and the next exec to work.

`run.sh <rootfs-init-extra.sh>` runs them against the real `/usr/bin/sandboxd` of this pylon without building an image. `drive-sandboxd.py` starts new PID and mount namespaces whose PID 1 runs the init tail that `/init` runs after the given file. It binds a pty over sandboxd's virtio port and sends exec requests in Gondolin's framed CBOR protocol, as the host does. Through it the script runs the smoke check, 20 commands launched the way `GuestProcesses.launch` launches them, one `setsid -f` start, a SIGPIPE disposition read, and the closed-stdin write. The idea of driving the real sandboxd this way came from the review.

| Init tail | Capture | PID 1 reaps orphans | Closed-stdin write | Zombies left |
| --- | --- | --- | --- | --- |
| main, `exec /usr/bin/sandboxd` | `main.txt` | fails, `sandboxd\nZ\n` | exits 0 | 22 |
| `exec tini` without the trap | `tini-without-trap.txt` | passes | PID 1 exits, the guest is gone | none, as nothing is left |
| this branch | `branch.txt` | passes | exits 0 | 0 |

On this branch a plain exec starts with SIGPIPE ignored (`SigIgn 0x1000`), and a command started through Python does not (`SigIgn 0x0`).

## What was not verified

- A pylon booted from a rebuilt image. Only a rebuild shows that sandboxd works as tini's child in the real guest, that execs, file RPCs, SSH, ingress and the relay still work, and that both smoke checks pass there. The new closed-stdin check in `smokeBoot` is typechecked but has not run, because it needs a built image.
- Shutdown and checkpoint resume with tini as PID 1. sandboxd has no PID 1 logic of its own (no signal handlers and no reboot call), so nothing is expected to change. This is read from the source, not seen.
- sandboxd also loses PID 1's other protections: the OOM killer can now pick it, and a signal sent to it or to its process group, such as `kill -TERM -1` as root, now kills it. Neither was tried. The OOM killer picks by memory use, and sandboxd uses a few MB.
- Pylons on images built before this change keep sandboxd as PID 1 and keep collecting zombies until they move to a rebuilt image.
