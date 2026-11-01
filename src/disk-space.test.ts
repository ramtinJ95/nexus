import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskRefusal, diskText, lowDisk, readDisks } from "./disk-space.ts";

const fs = (totalGiB: number, freeGiB: number) => ({ paths: ["/var/lib/nexus/pylons"], totalGiB, freeGiB, pylons: true as const });

test("each filesystem is read once with the watched paths on it, the first path's first, and a missing path is left out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-disks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [pylons, artifacts] = [join(root, "pylons"), join(root, "artifacts")];
  await Promise.all([mkdir(pylons), mkdir(artifacts)]);
  const disks = await readDisks(pylons, [artifacts, join(root, "absent"), pylons]);
  assert.equal(disks.length, 1, "both directories are on one filesystem");
  assert.deepEqual(disks[0]!.paths, [pylons, artifacts]);
  const real = await statfs(pylons);
  assert.ok(Math.abs(disks[0]!.totalGiB - real.blocks * real.bsize / 2 ** 30) < 0.01);
  assert.ok(disks[0]!.freeGiB > 0 && disks[0]!.freeGiB <= disks[0]!.totalGiB);
  await assert.rejects(readDisks(join(root, "absent"), []), { code: "ENOENT" }, "the pylons' own directory must exist");
});

test("a filesystem is low under 10% or 20 GiB free, whichever is larger", () => {
  assert.equal(lowDisk(fs(100, 20)), false, "20 GiB of 100 is neither under 20 GiB nor under 10%");
  assert.equal(lowDisk(fs(100, 19.9)), true, "under 20 GiB");
  assert.equal(lowDisk(fs(1000, 100)), false);
  assert.equal(lowDisk(fs(1000, 99)), true, "under 10% of 1000 GiB, though far over 20 GiB");
  assert.equal(diskText(fs(1000, 99)), "99.0 of 1000.0 GiB free at /var/lib/nexus/pylons, low");
  assert.equal(diskText({ paths: ["/", "/opt/nexus/releases"], totalGiB: 100, freeGiB: 50 }), "50.0 of 100.0 GiB free at /, /opt/nexus/releases");
});

test("a pylon boots only while its disk leaves max(10 GiB, 5%) of the pylons' filesystem free, and a refusal names the filesystem and its free space", () => {
  assert.equal(diskRefusal(fs(100, 20), 20, 10), null, "10 GiB left is the 10 GiB kept");
  assert.equal(diskRefusal(fs(100, 20), 20, 11), "has 20.0 of 100.0 GiB free on the filesystem of /var/lib/nexus/pylons, and a 11 GiB pylon disk would leave less than the 10.0 GiB it keeps free");
  assert.equal(diskRefusal(fs(1000, 110), 110, 60), null, "50 GiB left is the 5% kept");
  assert.match(diskRefusal(fs(1000, 110), 110, 61) ?? "", /less than the 50\.0 GiB it keeps free$/);
  assert.match(diskRefusal(fs(1000, 500), 70, 61) ?? "", /^has 70\.0 of 1000\.0 GiB free/, "the free space is what placement leaves once pending pylons are counted");
});
