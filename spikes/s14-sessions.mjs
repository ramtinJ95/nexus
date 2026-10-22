// S14: src/sessions.ts against the real Herdr in a pylon booted from the base image, on infra-testbench from
// ~/nexus-spikes (for its node_modules):
//   S14_IMAGE=<image dir, e.g. images/img-1a0db1870fb1> S14_SRC=<dir holding src/> node s14-sessions.mjs
// The rootfs is in memory, so the run leaves nothing behind. The image has Herdr's pi and Claude integrations,
// which report the session IDs the check asserts. It has no logins.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { VM } from '@earendil-works/gondolin';
import { vmOptions } from './s12-vm-options.mjs';

const image = process.env.S14_IMAGE;
const src = process.env.S14_SRC;
assert.ok(image && src, 'S14_IMAGE and S14_SRC are required');

const asUser = (script) => ['runuser', '-u', 'user', '--', 'bash', '-lc', script];
const { env: _s2Env, ...base } = vmOptions();
// 4 GiB, because a 2 GiB Gondolin 0.13.0 guest hangs at boot. The image's gondolin.json env sets PATH.
const vm = await VM.create({ ...base, sandbox: { ...base.sandbox, imagePath: path.resolve(image) }, rootfs: { mode: 'memory' }, memory: '4G', sessionLabel: 'nexus-s14-sessions' });
try {
  const run = async (name, argv) => {
    const started = performance.now();
    const r = await vm.exec(argv, { cwd: '/home/user' });
    console.log(`${name} exit=${r.exitCode} ms=${Math.round(performance.now() - started)}\n${r.stdout}${r.stderr}`);
    return r;
  };

  await run('VERSIONS', asUser('node --version; herdr --version; which claude pi'));
  await run('STEP1_HOME', asUser('echo $HOME'));
  // The image has no logins, and Claude Code at its login screen starts no session, so its SessionStart hook
  // never reports an ID. A placeholder API key, pre-approved, with onboarding and the trust dialog done, lets
  // it start one. No request with the key ever needs to succeed.
  const fakeKey = `sk-ant-api03-nexus-s14-placeholder-${'0'.repeat(20)}`;
  await vm.fs.writeFile('/home/user/.claude.json', JSON.stringify({
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [fakeKey.slice(-20)], rejected: [] },
    projects: { '/home/user': { hasTrustDialogAccepted: true } },
  }));
  await run('STEP1_SEED_CLAUDE', ['sh', '-c', `chown user:user /home/user/.claude.json && echo 'export ANTHROPIC_API_KEY=${fakeKey}' >> /home/user/.profile`]);

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) files.push(full);
    }
  };
  walk(path.join(src, 'src'));
  for (const file of files) {
    const rel = path.relative(src, file);
    await vm.exec(['mkdir', '-p', path.posix.join('/home/user/s14', path.dirname(rel))]);
    await vm.fs.writeFile(path.posix.join('/home/user/s14', rel), readFileSync(file));
  }
  await vm.exec(['chown', '-R', 'user:user', '/home/user/s14']);
  console.log(`COPIED ${files.length} files`);

  const check = await run('STEP3_CHECK', asUser('cd /home/user/s14 && node src/sessions.check.ts'));
  await run('STEP5_SNAPSHOT', asUser("herdr --session nexus server </dev/null >/dev/null 2>&1 & sleep 1; time herdr --session nexus api snapshot >/dev/null"));
  console.log(check.exitCode === 0 && /SESSIONS_CHECK_PASS/.test(check.stdout) ? 'S14_PASS' : 'S14_FAIL');
} finally {
  await vm.close();
}
