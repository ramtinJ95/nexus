import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VmCheckpoint } from '@earendil-works/gondolin';
import { checkpointPath, s2Hosts, vmOptions } from './s12-vm-options.mjs';
const userEnv = ['HOME=/home/user', 'XDG_CACHE_HOME=/home/user/.cache', 'XDG_CONFIG_HOME=/home/user/.config',
  'PI_SANDBOX_HOME=/home/user/.pi-sandbox', 'npm_config_cache=/home/user/nexus-spikes/npm-cache'];
const asUser = command => ['runuser', '-u', 'user', '--', 'env', ...userEnv, ...command];
let vm, server;
const serverAbort = new AbortController();
const started = performance.now();
console.log('S2_ALLOWLIST', JSON.stringify(s2Hosts));
try {
  vm = await VmCheckpoint.load(checkpointPath).resume(vmOptions());
  const first = await vm.exec(asUser(['bash', '-c', 'cd /home/user/workspace/repo; id; pwd; python3 --version; bash --version | head -1; node --version; claude --version; herdr --version; getconf GNU_LIBC_VERSION']));
  console.log(`S2_RESUME_FIRST_EXEC_MS=${Math.round(performance.now() - started)}`);
  console.log('NONROOT_VERSIONS', first.stdout, first.stderr, 'exit', first.exitCode);
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /uid=1000\(user\)/);
  assert.match(first.stdout, /v24\./);
  const safe = await vm.exec(asUser(['bash', '-c', 'test -z "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" && test ! -e /home/user/.claude/.credentials.json']));
  assert.equal(safe.exitCode, 0, 'No credentials may exist for this probe');
  server = vm.exec(asUser(['herdr', '--session', 'nexus-spike', 'server']), { stdout: 'inherit', stderr: 'inherit', signal: serverAbort.signal });
  server.catch(e => console.log('HERDR_SERVER_EXIT', e.message));
  let ready = false;
  const serverStarted = performance.now();
  for (let i = 0; i < 25; i++) {
    const r = await vm.exec(asUser(['herdr', '--session', 'nexus-spike', 'status', 'server']));
    if (r.exitCode === 0) { console.log('HERDR_STATUS', r.stdout, r.stderr); ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  console.log('HERDR_READY_MS=' + Math.round(performance.now() - serverStarted));
  assert.ok(ready, 'Non-root Herdr headless server must start');
  const stop = await vm.exec(asUser(['herdr', '--session', 'nexus-spike', 'server', 'stop']));
  console.log('HERDR_STOP', stop.stdout, stop.stderr, 'exit', stop.exitCode);
  assert.equal(stop.exitCode, 0);
  await server;
  for (const mode of ['without', 'with']) {
    const vars = mode === 'without' ? ['env', '-u', 'NODE_EXTRA_CA_CERTS'] : ['env', 'NODE_EXTRA_CA_CERTS=/etc/gondolin/mitm/ca.crt'];
    const t = performance.now();
    const curl = await vm.exec(asUser([...vars, 'curl', '--connect-timeout', '15', '--max-time', '30', '-sS', '-D-',
      '-w', '\nHTTP_STATUS=%{http_code}\n', 'https://api.anthropic.com/v1/models']), { cwd: '/home/user/workspace/repo' });
    console.log(`CURL_${mode.toUpperCase()}_EXTRA_CA_MS=${Math.round(performance.now() - t)} EXIT=${curl.exitCode}`);
    console.log(curl.stdout, curl.stderr);
    assert.equal(curl.exitCode, 0, `${mode} CA curl TLS must succeed`);
    assert.match(curl.stdout, /HTTP_STATUS=401/);
    const c = performance.now();
    const claude = await vm.exec(asUser([...vars, 'timeout', '45', 'claude', '-p', 'hi']), { cwd: '/home/user/workspace/repo' });
    console.log(`CLAUDE_${mode.toUpperCase()}_EXTRA_CA_MS=${Math.round(performance.now() - c)} EXIT=${claude.exitCode}`);
    console.log(claude.stdout, claude.stderr);
    assert.equal(claude.exitCode, 1, 'Unauthenticated Claude must reject');
    assert.match(claude.stdout + claude.stderr, /not logged in|please.*login|authentication|api key/i);
    assert.doesNotMatch(claude.stdout + claude.stderr, /CERT_HAS_EXPIRED|UNABLE_TO_VERIFY|certificate verify failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i);
  }
  fs.writeFileSync('state/s2-verified.json', JSON.stringify({ verified: true, loggedIn: false, checkpoint: checkpointPath, timestamp: new Date().toISOString() }, null, 2));
  console.log('S1_NONROOT_HERDR_PASS S2_UNAUTHENTICATED_TLS_PASS');
} finally {
  serverAbort.abort();
  if (vm) {
    const cp = await vm.checkpoint(checkpointPath);
    console.log('S2_STOPPED_CHECKPOINT', cp.path);
  }
}
