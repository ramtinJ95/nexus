/**
 * Makes this process repeat itself for the golden captures: the clock stops at NEXUS_GOLDEN_NOW, so `Date.now()` and
 * `new Date()` give that instant, and `randomBytes`, `randomUUID` and `Math.random` draw from a fixed seed, so thread
 * IDs, and the orders they sort in, are the same on each run. golden.test.ts imports it before the seed, and
 * preloads it with `--import` into each CLI it runs.
 */
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const at = Date.parse(process.env.NEXUS_GOLDEN_NOW ?? "");
if (Number.isNaN(at)) throw new Error("NEXUS_GOLDEN_NOW is not an ISO time");

const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: [] | ConstructorParameters<DateConstructor>) {
    if (args.length === 0) super(at);
    else super(...(args as ConstructorParameters<DateConstructor>));
  }
  static override now() { return at; }
}
globalThis.Date = FrozenDate as DateConstructor;

let drawn = 0;
function bytes(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let filled = 0; filled < size; filled += 32) createHash("sha256").update(`golden-${drawn++}`).digest().copy(out, filled);
  return out;
}
crypto.randomBytes = ((size: number, callback?: (err: Error | null, buf: Buffer) => void) => {
  const buf = bytes(size);
  if (callback === undefined) return buf;
  queueMicrotask(() => callback(null, buf));
}) as typeof crypto.randomBytes;
crypto.randomUUID = () => {
  const b = bytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReturnType<typeof crypto.randomUUID>;
};
Math.random = () => bytes(4).readUInt32BE() / 2 ** 32;
syncBuiltinESMExports();
