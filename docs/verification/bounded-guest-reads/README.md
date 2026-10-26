# Bounded guest reads

A pylon's stop failed before its checkpoint with `error queue_full: too many concurrent exec requests (limit 64)`, which left it `interrupted` and lost its work since the last checkpoint. These captures show that failure on main and the stop checkpointing with the fix.

This pylon has no `/dev/kvm` and no QEMU, so no real Gondolin VM could boot here. The runs drive the real `SandboxRuntime` in `src/pylon-vm/runtime.ts`, with its guest actions and stop, against `fakeVm` in `src/pylon-vm/fake-vm.ts`. That fake admits commands as Gondolin 0.13.0 does:

- At most 64 at once, and each one counts from its request until the guest answers it, also while it waits behind a file write (`sandbox/server-ops.js`, `handleExec` and `execPressure`).
- An abort ends only the host's wait (`exec.js`, `rejectExecSession`; `vm/core.js`, `execInternal`), and nothing tells the server, so the command keeps its slot.
- A command over the limit fails with Gondolin's own message, `error queue_full: too many concurrent exec requests (limit 64)`.

## The runs

`node --test --test-name-pattern="command slots" src/pylon-vm/runtime.test.ts`

`runtime-before.txt` runs the tests against main's `guest.ts` and `runtime.ts`, and `runtime-after.txt` runs them against the fix. A fourth test, that a stop refuses the reads still waiting for a slot, runs only against the fix, since main has no such wait.

- The first test sends 70 reads to a guest that has stopped answering. On main, all 64 slots fill and Gondolin refuses 6 commands as full. With the fix, reads hold at most 48 slots, and the other 22 wait in the controller. Each one runs once the guest answers a read, so all 70 are answered and Gondolin refuses none.
- The second test holds a file write the guest has not answered, then sends 65 reads. Gondolin queues commands behind the write and counts them, so on main it refuses the 65th as full. With the fix, 48 wait in Gondolin and 17 in the controller, and all 65 are answered once the write is.
- The third test sends 64 `exec-status` reads, the probe's status poll, to a guest that has stopped answering. Each read's wait ends after 13 s, as a 3 s guest command's does, and the command stays in Gondolin. Then the test stops the pylon. On main, the controller logs what controller.log showed in the incident: `settles the guest actions in flight: none`, then `error queue_full`, then `Stop failed before its checkpoint completed`. With the fix, the stop's commands find room and it checkpoints.

## What was not verified

No real VM ran, so the fix is untested against a real guest that slows down under load. The fake shows the counting and the reserved slots, but not how fast a real overloaded guest frees its slots.
