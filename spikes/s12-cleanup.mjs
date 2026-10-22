import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listSessions, VmCheckpoint } from '@earendil-works/gondolin';
const scratch = path.resolve(process.env.HOME, 'nexus-spikes');
if (process.cwd() !== scratch) throw new Error('Run only inside scratch');
const docker = args => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const own = JSON.parse(await fs.readFile('state/s12-owned-images.json', 'utf8'));
const approved = new Set(['debian:bookworm-slim', 'debian:bookworm', 'debian:trixie-slim', 'ubuntu:24.04']);
const ids = (await fs.readFile('state/s12-created-containers.txt', 'utf8')).trim().split('\n').filter(Boolean);
const leftover = [];
for (const id of ids) {
  assert.match(id, /^[a-f0-9]{64}$/);
  const row = docker(['ps', '-a', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}']);
  if (row) leftover.push(row);
}
console.log(`CREATED_CONTAINERS=${ids.length} REMAINING_CREATED_CONTAINERS=${leftover.length}`);
if (leftover.length) throw new Error('Created containers remain; inspect exact IDs before cleanup');
for (const image of own) {
  assert.ok(approved.has(image.tag), 'Do not remove any unapproved image');
  assert.equal(docker(['image', 'inspect', image.tag, '--format', '{{.Id}}']), image.id, 'Image changed since this run; refuse removal');
  console.log(`REMOVING_ONLY_OWN_IMAGE=${image.tag}`);
  console.log(docker(['rmi', image.tag]));
}
const images = docker(['images', '--no-trunc', '--format', '{{.ID}}']);
const containers = docker(['ps', '-a', '--no-trunc', '--format', '{{.ID}}']);
await fs.writeFile('logs/s12-images-after.txt', images + '\n');
await fs.writeFile('logs/s12-containers-after.txt', containers + '\n');
const lines = s => s.trim().split('\n').filter(Boolean).sort();
assert.deepEqual(lines(images), lines(await fs.readFile('logs/s12-images-before.txt', 'utf8')));
assert.deepEqual(lines(containers), lines(await fs.readFile('logs/s12-containers-before.txt', 'utf8')));
console.log(`IMAGES_AFTER=${lines(images).length} CONTAINERS_AFTER=${lines(containers).length} INVENTORY_RESTORED=true`);
const sessions = await listSessions();
console.log('SCRATCH_GONDOLIN_SESSIONS=' + sessions.length);
assert.equal(sessions.length, 0);
const qemu = [];
for (const pid of await fs.readdir('/proc')) {
  if (!/^\d+$/.test(pid)) continue;
  try {
    const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    const stat = await fs.stat(`/proc/${pid}`);
    if (stat.uid === process.getuid() && /^qemu-system-/.test(path.basename(args[0])) && args.some(a => a.includes(scratch + '/'))) qemu.push(pid);
  } catch {}
}
console.log('SCRATCH_QEMU_PIDS=' + JSON.stringify(qemu));
assert.equal(qemu.length, 0, 'Do not delete temporary directories while a scratch QEMU is live');
const cp = VmCheckpoint.load(path.join(scratch, 'state/s2-debian.qcow2'));
console.log('RETAINED_STOPPED_CHECKPOINT=' + cp.path);
console.log(execFileSync('qemu-img', ['info', '--backing-chain', cp.path], { encoding: 'utf8' }));
for (const name of await fs.readdir('tmp')) {
  if (/^(gondolin-build-|cp-repro-)/.test(name)) await fs.rm(path.join('tmp', name), { recursive: true, force: true });
}
for (const name of ['bookworm-slim-platform-assets', 'bookworm-platform-assets', 'trixie-slim-platform-assets', 'ubuntu2404-platform-assets', 'bookworm-slim-lts-assets']) {
  try { await fs.rmdir(path.join('state', name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
console.log('REMAINING_TMP=' + JSON.stringify(await fs.readdir('tmp')));
console.log('REMAINING_STATE=' + JSON.stringify(await fs.readdir('state')));
for (const name of (await fs.readdir(scratch)).sort()) {
  console.log(execFileSync('du', ['-sh', path.join(scratch, name)], { encoding: 'utf8' }).trim());
}
console.log('TOTAL=' + execFileSync('du', ['-sh', scratch], { encoding: 'utf8' }).trim());
