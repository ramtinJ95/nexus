// Run on infra-testbench via the documented SOCKS SSH route. Never auto-log in.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { VmCheckpoint } from '@earendil-works/gondolin';
import { checkpointPath, vmOptions } from './s12-vm-options.mjs';
const smoke = process.argv.includes('--smoke');
if (!smoke && !process.stdin.isTTY) throw new Error('Interactive mode requires an outer SSH terminal (-t). Use --smoke only for the no-login shell test.');
let vm, access, child;
const started = performance.now();
try {
  vm = await VmCheckpoint.load(checkpointPath).resume(vmOptions());
  const first = await vm.exec(['runuser', '-u', 'user', '--', 'id']);
  assert.equal(first.exitCode, 0);
  console.log('RESUME_FIRST_EXEC_MS=' + Math.round(performance.now() - started));
  console.log(first.stdout.trim());
  access = await vm.enableSsh({ user: 'user', listenHost: '127.0.0.1', listenPort: 0 });
  console.log(`SSH_READY_USER=${access.user} LISTEN=${access.host}:${access.port}`);
  const args = ['-tt', '-p', String(access.port), '-i', access.identityFile,
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.resolve('state/s2-known-hosts')}`, '-o', 'ConnectTimeout=15',
    `${access.user}@${access.host}`, 'export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin HOME=/home/user NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt; cd /home/user/workspace/repo && exec bash --noprofile --norc -i'];
  console.log(smoke ? 'SMOKE: shell only; no Claude/login/model call' : 'Guest shell: run claude, enter /login yourself, then exit Claude and run claude --remote-control. Exit the shell to stop and save the VM.');
  child = spawn('ssh', args, { stdio: smoke ? ['pipe', 'pipe', 'pipe'] : 'inherit' });
  let output = '';
  if (smoke) {
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => process.stderr.write(data));
    child.stdin.end('id\npwd\npython3 --version\nnode --version\nclaude --version\ncurl --max-time 20 -sS -o /dev/null -w "SHELL_HTTP_STATUS=%{http_code}\\n" https://api.anthropic.com/v1/models\necho NEXUS_S2_INTERACTIVE_USER_SHELL_OK\nexit\n');
  }
  const terminate = () => child?.kill('SIGTERM');
  process.once('SIGTERM', terminate);
  const timer = smoke ? setTimeout(terminate, 90000) : undefined;
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer);
  process.removeListener('SIGTERM', terminate);
  assert.equal(code, 0, 'SSH shell must exit cleanly');
  if (smoke) {
    assert.match(output, /uid=1000\(user\)/);
    assert.match(output, /\/home\/user\/workspace\/repo/);
    assert.match(output, /NEXUS_S2_INTERACTIVE_USER_SHELL_OK/);
    assert.match(output, /SHELL_HTTP_STATUS=401/);
    console.log('S2_RESUME_INTERACTIVE_SHELL_SMOKE_PASS');
  }
} finally {
  await access?.close();
  if (vm) {
    await vm.checkpoint(checkpointPath);
    console.log('STOPPED_AND_SAVED=' + checkpointPath);
  }
}
