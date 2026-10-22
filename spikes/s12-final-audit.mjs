import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listSessions, VmCheckpoint } from '@earendil-works/gondolin';
const scratch = path.resolve(process.env.HOME, 'nexus-spikes');
assert.equal(process.cwd(), scratch);
assert.equal((await listSessions()).length, 0);
for (const pid of await fs.readdir('/proc')) {
  if (!/^\d+$/.test(pid)) continue;
  let args;
  try { args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0'); } catch { continue; }
  if (/^qemu-system-/.test(path.basename(args[0])) && args.some(a => a.includes(scratch + '/'))) throw new Error(`Scratch VM still live: ${pid}`);
}
// Failed enableSsh (before sshd was installed) left one temporary key directory.
// No contents are printed; it belongs to this run and all VMs are stopped.
for (const name of await fs.readdir('tmp')) {
  if (name.startsWith('gondolin-ssh-')) {
    await fs.rm(path.join('tmp', name), { recursive: true, force: true });
    console.log('REMOVED_TEMP_SSH_DIRECTORY=' + name);
  }
}
const docker = args => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const lines = s => s.trim().split('\n').filter(Boolean).sort();
const images = docker(['images', '--no-trunc', '--format', '{{.ID}}']);
const containers = docker(['ps', '-a', '--no-trunc', '--format', '{{.ID}}']);
assert.deepEqual(lines(images), lines(await fs.readFile('logs/s12-images-before.txt', 'utf8')));
assert.deepEqual(lines(containers), lines(await fs.readFile('logs/s12-containers-before.txt', 'utf8')));
console.log(`IMAGES_BEFORE_AFTER=${lines(images).length}/${lines(images).length} CONTAINERS_BEFORE_AFTER=${lines(containers).length}/${lines(containers).length}`);
for (const id of lines(await fs.readFile('state/s12-created-containers.txt', 'utf8'))) {
  assert.equal(docker(['ps', '-a', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}']), '');
}
console.log('CREATED_CONTAINER_FILTERED_COUNT=0; SCRATCH_QEMU=0; SESSIONS=0');
const cp = VmCheckpoint.load(path.join(scratch, 'state/s2-debian.qcow2'));
console.log('CHECKPOINT', JSON.stringify(cp.toJSON()));
console.log(execFileSync('qemu-img', ['info', '--backing-chain', cp.path], { encoding: 'utf8' }));
console.log('TMP', JSON.stringify(await fs.readdir('tmp')));
console.log('STATE', JSON.stringify(await fs.readdir('state')));
console.log(execFileSync('du', ['-sh', 'state', 'cache', 'tools', 'node_modules', 'npm-cache', 'tmp'], { encoding: 'utf8' }));
console.log('TOTAL=' + execFileSync('du', ['-sh', '.'], { encoding: 'utf8' }).trim());
