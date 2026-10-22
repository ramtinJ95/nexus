import fs from 'node:fs';
import { VM, VmCheckpoint } from '@earendil-works/gondolin';
import { checkpointPath, provisionHosts, vmOptions } from './s12-vm-options.mjs';
let vm;
let completed = false;
const start = performance.now();
const resuming = fs.existsSync(checkpointPath);
console.log('PROVISION_ALLOWLIST', JSON.stringify(provisionHosts));
try {
  vm = resuming ? await VmCheckpoint.load(checkpointPath).resume(vmOptions(provisionHosts)) : await VM.create(vmOptions(provisionHosts));
  const first = await vm.exec('uname -a; cat /etc/os-release; id');
  console.log(`${resuming ? 'RESUME' : 'DEBIAN_COLD_BOOT'}_FIRST_EXEC_MS=${Math.round(performance.now() - start)}`);
  console.log(first.stdout, first.stderr);
  if (first.exitCode) throw new Error('First exec failed');
  const run = await vm.exec(['/bin/bash', '-s'], { stdin: fs.readFileSync('s1-guest-provision.sh'), stdout: 'inherit', stderr: 'inherit', signal: AbortSignal.timeout(1200000) });
  if (run.exitCode) throw new Error(`Guest provision exit ${run.exitCode}`);
  const verify = await vm.exec(['runuser', '-u', 'user', '--', 'env', 'HOME=/home/user', 'bash', '-c',
    'cd /home/user/workspace/repo; id; pwd; python3 --version; bash --version | head -1; node --version; claude --version; herdr --version; herdr server --help']);
  console.log('NONROOT_VERIFICATION', verify.stdout, verify.stderr, 'exit', verify.exitCode);
  if (verify.exitCode) throw new Error('Non-root verification failed');
  completed = true;
} finally {
  if (vm) {
    const cp = await vm.checkpoint(checkpointPath);
    console.log('STOPPED_CHECKPOINT', cp.path, completed ? 'PROVISIONED_PENDING_HERDR_SERVER_CHECK' : 'INCOMPLETE_PROVISION');
  }
  console.log('PROVISION_TOTAL_MS=' + Math.round(performance.now() - start));
}
