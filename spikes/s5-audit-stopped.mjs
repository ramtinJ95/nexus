// Read-only host audit; never opens the checkpoint or guest credential files.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listSessions } from '@earendil-works/gondolin';

const scratch = path.resolve(process.env.HOME, 'nexus-spikes');
assert.equal(process.cwd(), scratch);
assert.equal((await listSessions()).length, 0, 'Gondolin sessions must be stopped');
for (const pid of await fs.readdir('/proc')) {
  if (!/^\d+$/.test(pid)) continue;
  let args;
  try { args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0'); }
  catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) continue;
    throw error;
  }
  if (/^qemu-system-/.test(path.basename(args[0])) && args.some(a => a.includes(scratch + '/'))) {
    throw new Error(`Scratch VM still live: ${pid}`);
  }
}
assert.ok((await fs.stat('state/s2-debian.qcow2')).isFile());
console.log('CHECKPOINT_PRESENT; SCRATCH_QEMU=0; SESSIONS=0');
