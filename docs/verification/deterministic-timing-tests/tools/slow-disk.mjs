// Preloaded with NODE_OPTIONS="--import <this file>": each node:sqlite statement that writes, and each exec, blocks
// the process for WRITE_MS, 30 by default, as a commit's fsync does on a slow disk. The registry's writes are
// synchronous, so this holds up the whole event loop, as it did on the old disk.
import { DatabaseSync, StatementSync } from "node:sqlite";
const writeMs = Number(process.env.WRITE_MS ?? 30);
const cell = new Int32Array(new SharedArrayBuffer(4));
const block = () => Atomics.wait(cell, 0, 0, writeMs);
const run = StatementSync.prototype.run;
StatementSync.prototype.run = function (...args) {
  const result = run.apply(this, args);
  if (result.changes > 0) block();
  return result;
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (...args) {
  exec.apply(this, args);
  block();
};
