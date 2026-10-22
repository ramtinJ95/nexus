// Fresh disk-only cross-vendor checkpoint test. Never opens any S2 file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { VM, VmCheckpoint, createHttpHooks } from '@earendil-works/gondolin';

const mode = process.argv[2];
assert.ok(['create', 'forward', 'return', 'relocated'].includes(mode));
const dir = path.resolve('s7');
const checkpoint = path.join(dir, mode === 'create' || mode === 'forward' ? 'intel.qcow2' : 'amd.qcow2');
const tokenPath = path.join(dir, 'tokens.json');
const tokens = mode === 'create' ? { intel: randomBytes(24).toString('hex') } : JSON.parse(fs.readFileSync(tokenPath));
const { httpHooks } = createHttpHooks({ allowedHosts: [] });
const options = {
  sandbox: { vmm: 'qemu', accel: 'kvm', imagePath: path.join(dir, mode === 'relocated' ? 'relocated-assets' : 'assets') },
  rootfs: { mode: 'cow' }, memory: '3G', cpus: 2, startTimeoutMs: 60000,
  env: { PATH: '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin' },
  sessionLabel: `nexus-s7-${mode}`, httpHooks,
};
const asUser = command => ['runuser', '-u', 'user', '--', 'env', 'HOME=/home/user', 'sh', '-eu', '-c', command];
let vm;
async function exec(command) {
  const r = await vm.exec(command, { signal: AbortSignal.timeout(30000) });
  assert.equal(r.exitCode, 0, `${JSON.stringify(command)}: ${r.stderr}`);
  return r.stdout;
}
try {
  const t = performance.now();
  vm = mode === 'create' ? await VM.create(options) : await VmCheckpoint.load(checkpoint).resume(options);
  const first = await exec(['sh', '-eu', '-c', 'uname -a; awk -F ": " \'/^model name/ {print "GUEST_CPU=" $2; exit}\' /proc/cpuinfo']);
  console.log(`${mode.toUpperCase()}_COLD_FIRST_EXEC_MS=${Math.round(performance.now() - t)}`);
  console.log(first.trim());
  if (mode === 'create') {
    // The S1 base predates S2 provisioning: create only a locked, non-root user.
    console.log(await exec(['sh', '-eu', '-c', 'if ! id user >/dev/null 2>&1; then useradd -m -u 1000 -s /bin/bash user; fi; mkdir -p /home/user/workspace; chown user:user /home/user/workspace; passwd -S user']));
    await exec(asUser(`printf '%s\\n' '${tokens.intel}' > /home/user/workspace/s7-intel-marker; sync`));
  }
  console.log((await exec(asUser('id; test "$(id -u)" = 1000; cd /home/user/workspace; printf "EXEC_OK\\n"'))).trim());
  // Check absence, never read authentication files.
  await exec(['sh', '-eu', '-c', 'test ! -e /home/user/.claude; test ! -e /home/user/.pi; test ! -e /root/.claude; test ! -e /root/.pi']);
  console.log('LOGIN_STATE_ABSENT=true');
  assert.equal((await exec(asUser('cat /home/user/workspace/s7-intel-marker'))).trim(), tokens.intel);
  console.log('INTEL_MARKER_VERIFIED=' + tokens.intel);
  if (mode === 'forward') {
    tokens.amd = randomBytes(24).toString('hex');
    await exec(asUser(`printf '%s\\n' '${tokens.amd}' > /home/user/workspace/s7-amd-marker; sync`));
  }
  if (mode !== 'create') {
    assert.match(tokens.amd, /^[a-f0-9]{48}$/);
    assert.equal((await exec(asUser('cat /home/user/workspace/s7-amd-marker'))).trim(), tokens.amd);
    console.log('AMD_MARKER_VERIFIED=' + tokens.amd);
  }
  if (mode === 'create' || mode === 'forward') {
    fs.writeFileSync(tokenPath, JSON.stringify(tokens) + '\n', { mode: 0o600 });
    const out = path.join(dir, mode === 'create' ? 'intel.qcow2' : 'amd.qcow2');
    const stop = performance.now();
    await vm.checkpoint(out);
    vm = undefined;
    console.log(`CHECKPOINT_MS=${Math.round(performance.now() - stop)}`);
    console.log('STOPPED_CHECKPOINT=' + path.basename(out));
  }
  console.log(`S7_${mode.toUpperCase()}_PASS`);
} finally {
  if (vm) await vm.close();
}
