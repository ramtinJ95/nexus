import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const scratch = path.resolve(process.env.HOME, 'nexus-spikes');
if (process.cwd() !== scratch) throw new Error('Run only inside scratch');
if (process.argv[2] === 'child') {
  const base = process.argv[3];
  if (!base.startsWith(path.join(scratch, 'tmp/cp-isolated-'))) throw new Error('Unexpected fixture path');
  fs.cpSync(path.join(base, 'src'), path.join(base, 'dest'), { recursive: true, dereference: false });
} else {
  const base = fs.mkdtempSync(path.join(scratch, 'tmp/cp-isolated-'));
  const denied = path.join(base, 'denied');
  fs.mkdirSync(denied);
  fs.writeFileSync(path.join(denied, 'kernel'), 'fixture only\n');
  fs.mkdirSync(path.join(base, 'src'));
  fs.symlinkSync(path.join(denied, 'kernel'), path.join(base, 'src/vmlinuz'));
  fs.chmodSync(denied, 0);
  try {
    const r = spawnSync(process.execPath, [process.argv[1], 'child', base], { encoding: 'utf8', timeout: 10000 });
    console.log(JSON.stringify({ runtime: process.version, status: r.status, signal: r.signal }));
    console.log(r.stderr);
    if (r.signal !== 'SIGABRT') throw new Error('Expected the same SIGABRT in the isolated fixture');
    console.log('ISOLATED_REPRO_CONFIRMED_NO_HOST_BOOT_DEPENDENCY');
  } finally {
    fs.chmodSync(denied, 0o700);
    fs.rmSync(base, { recursive: true });
  }
}
