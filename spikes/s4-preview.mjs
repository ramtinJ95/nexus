import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { VM } from '@earendil-works/gondolin';
const start = performance.now();
let vm, ingress, server;
try {
  for (const marker of ['s4-stop', 's4-ready', 's4-serve-enabled']) {
    await fs.rm(`state/${marker}`, { force: true });
  }
  vm = await VM.create({ sessionLabel: 'nexus-s4-preview', sandbox: { vmm: 'qemu', accel: 'kvm' }, startTimeoutMs: 60000 });
  const first = await vm.exec('python3 --version');
  assert.equal(first.exitCode, 0);
  console.log(`COLD_BOOT_FIRST_EXEC_MS=${Math.round(performance.now() - start)}`, first.stdout);
  await vm.fs.mkdir('/root/nexus-preview', { recursive: true });
  await vm.fs.writeFile('/root/nexus-preview/index.html', 'nexus-preview-from-gondolin\n');
  await vm.fs.writeFile('/root/nexus-preview/sitecustomize.py', await fs.readFile('s4-sitecustomize.py'));
  server = vm.exec(['python3', '-u', '-m', 'http.server', '8080', '--bind', '127.0.0.1'], {
    cwd: '/root/nexus-preview', env: { PYTHONPATH: '/root/nexus-preview' }, stdout: 'inherit', stderr: 'inherit',
  });
  server.catch(e => console.error('guest-server-closed:', e.message));
  vm.setIngressRoutes([{ prefix: '/', port: 8080, stripPrefix: false }]);
  ingress = await vm.enableIngress({ listenHost: '127.0.0.1', listenPort: 18080 });
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = await fetch(ingress.url, { signal: AbortSignal.timeout(3000) });
    const body = await r.text();
    if (r.status === 200 && body.includes('nexus-preview-from-gondolin')) { ready = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(ready, 'local ingress must reach guest');
  await fs.writeFile('state/s4-ready', ingress.url);
  console.log('INGRESS_READY', ingress.url, `READY_MS=${Math.round(performance.now() - start)}`);
  for (let i = 0; i < 300; i++) {
    try { await fs.access('state/s4-stop'); break; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
} finally {
  await ingress?.close();
  await vm?.close();
  console.log('S4_VM_CLOSED');
}
