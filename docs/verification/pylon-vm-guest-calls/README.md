# Pylon VM guest calls

A one-line probe exec on a pylon VM started eight guest commands, each a python3 watchdog that starts a login shell, besides the launcher and the worker. A services status re-read services.yaml, checked a process-health service twice and rewrote status.json. Every client request was preceded by an inspect. These captures count those calls on main and on the branch.

`./run.sh <ref>` checks out the ref, loads its `processes.ts`, `services.ts`, `runtime.ts` and `client.ts`, and drives them with `count.ts`. That script simulates the guest in memory, answering the shell commands the modules send and running a launched worker at once, and serves a fake controller on the instance's socket. It counts what the modules ask of Gondolin and of the controller, not how long that takes. `main.txt` is `./run.sh origin/main` and `branch.txt` is `./run.sh` of the branch.

What the counts show:

- A probe exec drops from 8 guest commands (mkdir, the launcher, five `test -e` and an `rm -rf`) to one, the launcher. It reads one file more, since `done` is polled by reading it. The worker is written once per controller, so the second exec writes nothing.
- A services status of a process-health service drops from 5 guest commands to 3: one `stat` of services.yaml replaces the `test -e` and Gondolin's `vm.fs.stat`, which is itself a guest shell, and the process is checked once. An unchanged file is not read again, and a status that changes nothing leaves status.json alone.
- A client request reaches the controller once, with no inspect before it.

## Not checked live

This pylon has no `/dev/kvm` and no QEMU, so no Gondolin VM booted. Gondolin runs one file operation at a time and commands wait behind it, so a status wait that polls `done` now holds that slot for one short read every 100 ms instead of starting a process. Each read is one RPC round trip of a few bytes, where the `test -e` it replaces started python3 and a login shell and also waited behind the slot. That it is cheaper on a real guest is inferred from that, not measured.
