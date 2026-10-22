import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VmCheckpoint } from '@earendil-works/gondolin';
import { checkpointPath, guestPath, guestCa, s5Options } from './s5-vm-options.mjs';

let vm;
const started = performance.now();
try {
  const script = await readFile(new URL('./s5-guest-install-pi.sh', import.meta.url), 'utf8');
  vm = await VmCheckpoint.load(checkpointPath).resume(s5Options());
  const first = await vm.exec(['runuser', '-u', 'user', '--', 'id']);
  assert.equal(first.exitCode, 0);
  console.log('RESUME_FIRST_EXEC_MS=' + Math.round(performance.now() - started));
  const installing = performance.now();
  const result = await vm.exec(['runuser', '-u', 'user', '--', 'env', 'HOME=/home/user',
    `PATH=${guestPath}`, `NODE_EXTRA_CA_CERTS=${guestCa}`, 'bash', '-c', script], {
    stdout: 'inherit', stderr: 'inherit', signal: AbortSignal.timeout(300000),
  });
  console.log('INSTALL_AND_VERIFY_MS=' + Math.round(performance.now() - installing));
  assert.equal(result.exitCode, 0, 'Non-root pi install and login-PATH verification must succeed');
} finally {
  if (vm) {
    const saving = performance.now();
    await vm.checkpoint(checkpointPath);
    console.log('CHECKPOINT_MS=' + Math.round(performance.now() - saving));
    console.log('STOPPED_AND_SAVED=' + checkpointPath);
  }
  console.log('TOTAL_MS=' + Math.round(performance.now() - started));
}
