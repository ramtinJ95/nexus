import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listSessions } from '@earendil-works/gondolin';

const scratch = path.resolve(process.env.HOME, 'nexus-spikes');
if (process.cwd() !== scratch) throw new Error('Run only from ~/nexus-spikes');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function ownedQemu(pid) {
  try {
    const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    const stat = await fs.stat(`/proc/${pid}`);
    return stat.uid === process.getuid() && /^qemu-system-/.test(path.basename(args[0])) && args.some(a => a.includes(scratch + '/'));
  } catch { return false; }
}
const killed = [];
for (const pid of await fs.readdir('/proc')) {
  if (!/^\d+$/.test(pid) || !await ownedQemu(pid)) continue;
  process.kill(Number(pid), 'SIGTERM');
  await pause(1500);
  if (await ownedQemu(pid)) process.kill(Number(pid), 'SIGKILL');
  killed.push(pid);
}
console.log('STRAY_QEMU_KILLED', JSON.stringify(killed));
const sessions = await listSessions();
console.log('SCRATCH_GONDOLIN_SESSIONS', JSON.stringify(sessions));
if (sessions.length) throw new Error('Sessions remain; inspect before declaring cleanup');
// Initial image-inspect failed on permissions, so this intention marker was not proof of a pull.
// Gondolin failed at Docker create; no OCI image/container was created or pulled by this run.
await fs.rm('state/docker-pulled-by-spike', { force: true });
for (const marker of ['s4-ready', 's4-serve-enabled', 's4-stop']) await fs.rm(`state/${marker}`, { force: true });
try { await fs.rmdir('state/debian-assets'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
console.log('DOCKER: no successful pull/create; no image or container to remove');
console.log('S2_CHECKPOINT: absent (S1 blocked before image creation)');
console.log('SCRATCH_CONTENTS');
const names = (await fs.readdir(scratch)).sort();
for (const name of names) console.log(execFileSync('du', ['-sh', path.join(scratch, name)], { encoding: 'utf8' }).trim());
console.log('TOTAL', execFileSync('du', ['-sh', scratch], { encoding: 'utf8' }).trim());
console.log('REMAINING_STATE_FILES', JSON.stringify(await fs.readdir('state')));
