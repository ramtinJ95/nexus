/**
 * Checks, on main's runtime.ts, that for every intent.json the branch still reads, main's setupState gives the boot
 * exactly what the branch's `setupOnDisk(marker, record)` gives: the same `done`, and `mark` false. The boot reads the
 * marker only from a disk, so the cases with no disk have no marker. Prints one line per case and fails on the first
 * difference.
 *
 *   node docs/verification/drop-old-compat/setup-equivalence.ts <main checkout>
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const { readIntent, setupMarkerOf, setupOnDisk, setupState } = await import(join(root, "src/pylon-vm/runtime.ts"));
const record = { name: "pylon-a", createdAt: "2027-01-01T00:00:00.000Z" };
const markers: [string, string | null][] = [
  ["no marker", null],
  ["its own finished setup", setupMarkerOf(record, undefined)],
  ["its own failed setup", setupMarkerOf(record, "Setup exited 3")],
  ["a template build's setup", setupMarkerOf({ name: "tpl-0123456789ab", createdAt: "2026-12-31T00:00:00.000Z" }, undefined)],
  ["a same-named earlier instance's setup", setupMarkerOf({ ...record, createdAt: "2026-12-01T00:00:00.000Z" }, undefined)],
];
const dir = await mkdtemp(join(tmpdir(), "nexus-equivalence-"));
let cases = 0;
for (const intent of [{ prepare: false }, { prepare: true }]) {
  await writeFile(join(dir, "intent.json"), JSON.stringify(intent));
  const { setupRan } = await readIntent(dir);
  for (const disk of [true, false]) {
    for (const [label, marker] of disk ? markers : markers.slice(0, 1)) {
      const main = setupState(disk, marker, record, setupRan);
      const branch = { done: setupOnDisk(marker, record), mark: false };
      assert.deepEqual(main, branch, `${JSON.stringify(intent)}, ${disk ? "from a disk" : "from no disk"}, ${label}`);
      console.log(`${JSON.stringify(intent)} ${disk ? "from a disk" : "from no disk"}, ${label}: main ${JSON.stringify(main)} = branch ${JSON.stringify(branch)}`);
      cases++;
    }
  }
}
await rm(dir, { recursive: true });
console.log(`${cases} cases equal`);
