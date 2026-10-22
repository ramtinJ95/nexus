import { VmCheckpoint } from '@earendil-works/gondolin';
import { checkpointPath, provisionHosts, vmOptions } from './s12-vm-options.mjs';
let vm;
try {
  vm = await VmCheckpoint.load(checkpointPath).resume(vmOptions(provisionHosts));
  const r = await vm.exec('DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server', {
    stdout: 'inherit', stderr: 'inherit', signal: AbortSignal.timeout(240000),
  });
  if (r.exitCode) throw new Error('Guest openssh-server install failed');
  const check = await vm.exec('/usr/sbin/sshd -V');
  console.log('GUEST_SSHD', check.stdout, check.stderr, 'exit', check.exitCode);
} finally {
  if (vm) { await vm.checkpoint(checkpointPath); console.log('STOPPED_CHECKPOINT', checkpointPath); }
}
