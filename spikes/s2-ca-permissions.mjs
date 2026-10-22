import { VmCheckpoint } from '@earendil-works/gondolin';
import { checkpointPath, vmOptions } from './s12-vm-options.mjs';
let vm;
try {
  vm = await VmCheckpoint.load(checkpointPath).resume(vmOptions());
  const r = await vm.exec('ls -ld /etc/gondolin /etc/gondolin/mitm /etc/gondolin/mitm/ca.crt /run/gondolin/ca-certificates.crt; grep -E "( /data | /etc/gondolin)" /proc/mounts; runuser -u user -- sh -c \'test -r /etc/gondolin/mitm/ca.crt; echo MITM_CA_USER_READ_EXIT=$?; test -r /run/gondolin/ca-certificates.crt; echo RUNTIME_CA_USER_READ_EXIT=$?\'');
  console.log(r.stdout, r.stderr, 'exit', r.exitCode);
  if (r.exitCode) throw new Error('Permission diagnostic failed');
} finally {
  if (vm) { await vm.checkpoint(checkpointPath); console.log('STOPPED_CHECKPOINT', checkpointPath); }
}
