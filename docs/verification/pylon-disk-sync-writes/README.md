# Slow synced writes in pylons

Measured in this task's pylon on `infra-testbench` on 2026-10-26, on branch `pylon-disk-sync-writes`. The pylon has 4 CPUs, 6 GiB of memory and a 20 GiB disk. No live control plane, node or other thread was touched.

## The cause

Gondolin 0.13 attaches the pylon's disk as `-drive file=<overlay>,format=qcow2,if=none,id=drive0` (`node_modules/@earendil-works/gondolin/dist/src/sandbox/controller.js`, `buildQemuArgs`). It passes no `cache=` or `aio=`, so QEMU uses its default writeback mode. That mode gives the guest a volatile write cache, and the guest's `/sys/block/vda/queue/write_cache` reads `write back`. Each guest flush becomes an fdatasync of the overlay on the node. The guest mounts `/dev/vda` as ext4 with `rw,relatime`, so ext4 sends a flush on every fsync. The overlay is a qcow2 file in the controller's temporary directory, backed by the image's rootfs, or by the last checkpoint after a resume.

`measure-compare.txt` is `sh measure.sh compare`. It measures the same disk under both settings of the guest's write cache.

- With `write back`, a 4 KiB write with `oflag=dsync` or an append with fsync took 66 ms. The guest sent 301 flushes for about 300 synced writes, so there is one flush per synced write and no amplification in the guest. An earlier run in this pylon measured 22 to 24 ms, and builders measured 120 ms on both nodes. That range is the node's fdatasync latency under whatever load it has at the time.
- With `write through`, the same writes took 0.55 ms each, and the guest sent no flushes.
- Bulk writes ran at 1.0 to 2.1 GB/s under both settings, with `conv=fdatasync` too. Throughput is fine, and only the per-flush wait is slow.

The node's own storage is why one fdatasync costs tens of milliseconds. Nexus's VM setup is why every fsync in a pylon waits for one, and those waits protect nothing. The running VM writes to an overlay that `VM.close` deletes, and every boot resumes `disk.qcow2`, the last checkpoint. So a crash of the node, QEMU or the guest loses the work since the last pause whether the guest flushed or not.

## The fix, measured

`check-before.txt` and `check-after.txt` are both `sh .nexus/check` (npm ci, typecheck, `npm test`) at `bfc5bc5` in this pylon. Only the guest's write cache setting differs, set by hand as this branch's boot sets it. This pylon's own controller predates the branch, so the setting was applied with sudo for the run and then restored.

- `write back`, as pylons run today: 1302 s for the check, 1290 s for the suite, 1100 of 1100 passing. The SQLite event-retention test took 1057 s, and the session-state test took 768 s.
- `write through`, as this branch boots them: 201 s for the check, 188 s for the suite, 1100 of 1100 passing. Those two tests took 16 s and 21 s. The builders got 187 s on a tmpfs, so the suite is no longer bound by the disk.

## Checkpoints

After a boot sets `write through`, the guest's `sync` sends nothing to QEMU. QEMU keeps qcow2's L2 and refcount tables in memory until a flush or a clean exit. A stop therefore sets `write back` again before its `sync`. If that write fails, the stop fails before its checkpoint and the instance is `interrupted`, so a checkpoint is never taken without the flush. In this pylon, each `sync` under `write back` sent one flush even with nothing dirty. With `write through` it sent none. So a checkpoint is written exactly as before this branch. The guest's dirty pages reach QEMU, and one flush writes QEMU's metadata and fdatasyncs the overlay before Gondolin stops QEMU and moves the overlay into place.

## What was not verified

- A pylon booted by a controller running this branch. That needs a deploy. After one, open a terminal in a new or freshly woken pylon and run `sh docs/verification/pylon-disk-sync-writes/measure.sh`. It should print `write_cache: write through`, about 1 ms or less per synced write, and 0 flushes. Then pause and wake the pylon and check that its files survived. A check pylon's `.nexus/check` should take about 200 s.
- The node itself. With access to it, I would run `findmnt -T "$TMPDIR"` and `fio --name=fsync --directory=<controller scratch dir> --rw=write --bs=4k --size=64m --fsync=1` on the probe's scratch directory to get its raw fdatasync latency. I would also read `cat /sys/block/<dev>/queue/write_cache` and `nvme id-ctrl /dev/<dev> | grep vwc` for whether the device has a volatile cache without power-loss protection, and run `iostat -x 1` while a check runs.
- fio inside the pylon. It is not in the image, so `measure.sh` uses dd and an fsync loop.
