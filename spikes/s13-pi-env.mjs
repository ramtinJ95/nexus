// S13: pi-env's RemoteExecutionEnv over a byte stream that is not pi-env's own SSH deployment.
//   node s13-pi-env.mjs relay-local     local daemon behind a pumping bridge process (runs in the Mac sandbox)
//   node s13-pi-env.mjs gondolin-exec   guest daemon on Gondolin vm.exec stdio, through a Unix-socket bridge
//   node s13-pi-env.mjs gondolin-ssh    guest daemon over vm.enableSsh, ssh as the Connection command
// S13_WATCH_MODE=polling forces the daemon's polling watcher in the conformance cases.
// The Gondolin modes resume state/s2-debian.qcow2 and close the VM without a checkpoint, so the
// credential-bearing disk is never rewritten.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Connection, RemoteExecutionEnv, localDaemon, packagedDaemon } from '@earendil-works/pi-env';
import { createEnvConformance } from '@earendil-works/pi-durable/testing';

const mode = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(here, 's13-bridge.mjs');
const guestDaemon = '/home/user/.local/libexec/pi-env';
const log = (text) => process.stderr.write(`[daemon] ${text}`);

let vm, ssh, server, command, cut;
const sockets = new Set();

if (mode === 'relay-local') {
  process.env.S13_BRIDGE_PIDFILE = path.resolve('s13-bridge.pid');
  command = [process.execPath, bridge, 'spawn', localDaemon()];
  cut = () => process.kill(Number(readFileSync(process.env.S13_BRIDGE_PIDFILE, 'utf8')), 'SIGKILL');
} else if (mode === 'gondolin-exec' || mode === 'gondolin-ssh') {
  const { VmCheckpoint } = await import('@earendil-works/gondolin');
  const { checkpointPath, vmOptions } = await import('./s12-vm-options.mjs');
  const bootStart = performance.now();
  // S13_CHECKPOINT points at a copy, so a resume that rewrites its disk cannot touch the login in the original.
  vm = await VmCheckpoint.load(process.env.S13_CHECKPOINT ?? checkpointPath).resume(vmOptions());
  console.log(`RESUME_FIRST_EXEC_MS=${Math.round(performance.now() - bootStart)}`);
  const binary = readFileSync(packagedDaemon({ platform: 'linux', arch: 'x64' }));
  const sha256 = createHash('sha256').update(binary).digest('hex');
  // Uploaded to /tmp, because Gondolin's writeFile does not create the missing ~/.local/libexec.
  await vm.fs.writeFile('/tmp/pi-env.upload', binary);
  const install = await vm.exec(['sh', '-c', `set -e; d=$(dirname ${guestDaemon}); mkdir -p "$d"; mv /tmp/pi-env.upload ${guestDaemon}; chmod 755 ${guestDaemon}; chown -R user:user /home/user/.local; sha256sum ${guestDaemon}`]);
  assert.equal(install.exitCode, 0, install.stderr);
  assert.equal(install.stdout.split(' ')[0], sha256, 'guest daemon matches the packaged binary');
  console.log(`GUEST_DAEMON_SHA256=${sha256}`);
  if (mode === 'gondolin-exec') {
    const socketPath = path.resolve('tmp/s13-bridge.sock');
    rmSync(socketPath, { force: true });
    server = net.createServer((socket) => {
      sockets.add(socket);
      let header = Buffer.alloc(0);
      const onHeader = (chunk) => {
        header = Buffer.concat([header, chunk]);
        const newline = header.indexOf(10);
        if (newline === -1) return;
        socket.off('data', onHeader);
        const serveArgs = JSON.parse(header.subarray(0, newline).toString('utf8'));
        const proc = vm.exec(['runuser', '-u', 'user', '--', guestDaemon, ...serveArgs], {
          stdin: true, stdout: 'pipe', stderr: 'pipe', cwd: '/home/user',
          env: { HOME: '/home/user', USER: 'user', PATH: '/usr/local/bin:/usr/bin:/bin', NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt' },
        });
        const rest = header.subarray(newline + 1);
        if (rest.length > 0) proc.write(rest);
        socket.on('data', (data) => proc.write(data));
        socket.on('close', () => { sockets.delete(socket); proc.end(); });
        proc.stdout.pipe(socket);
        proc.stderr.on('data', (data) => log(data.toString('utf8')));
        proc.result.then((r) => { log(`guest daemon exited ${r.exitCode}\n`); socket.end(); }, (e) => { log(`guest exec failed: ${e.message}\n`); socket.destroy(); });
      };
      socket.on('data', onHeader);
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    command = [process.execPath, bridge, 'socket', socketPath];
    cut = () => { for (const socket of sockets) socket.destroy(); };
  } else {
    ssh = await vm.enableSsh({ user: 'user', listenHost: '127.0.0.1', listenPort: 0 });
    command = ['ssh', '-T', '-p', String(ssh.port), '-i', ssh.identityFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=15',
      `user@${ssh.host}`, guestDaemon];
    cut = () => execFileSync('pkill', ['-KILL', '-f', `ssh -T -p ${ssh.port}`]);
  }
} else {
  throw new Error('usage: node s13-pi-env.mjs relay-local|gondolin-exec|gondolin-ssh');
}

const assertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
  deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
  partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
  rejects: (operation, includes) => assert.rejects(operation, (error) => String(error?.message).includes(includes)),
};

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(2);
}
async function timed(label, n, operation) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const result = await operation();
    samples.push(performance.now() - start);
    assert.ok(result.ok, `${label}: ${result.error?.message}`);
  }
  console.log(`${label} n=${n} median_ms=${percentile(samples, 0.5)} p95_ms=${percentile(samples, 0.95)}`);
}

const connection = new Connection({ command, onLog: log });
try {
  const helloStart = performance.now();
  const info = await connection.info();
  console.log(`HELLO_MS=${Math.round(performance.now() - helloStart)} os=${info.os} arch=${info.arch} version=${info.version} features=${JSON.stringify(info.features ?? [])} home=${info.home}`);
  const base = new RemoteExecutionEnv({ connection, id: 'pi-env:s13', cwd: info.tmpdir });

  const cases = createEnvConformance({
    assertions, listFiles: true,
    withEnv: async (use) => {
      const dir = await base.createTempDir('s13-', context);
      assert.ok(dir.ok, dir.error?.message);
      try {
        await use(new RemoteExecutionEnv({ connection, id: 'pi-env:s13', cwd: dir.value, ...(process.env.S13_WATCH_MODE ? { watch: { mode: process.env.S13_WATCH_MODE, pollIntervalMs: 200 } } : {}) }));
      } finally {
        await base.remove(dir.value, { recursive: true, force: true }, context);
      }
    },
  });
  const failures = [];
  const suiteStart = performance.now();
  for (const testCase of cases) {
    try {
      await Promise.race([testCase.run(), new Promise((_, reject) => setTimeout(() => reject(new Error('case timed out')), testCase.timeoutMs ?? 30_000).unref())]);
    } catch (error) {
      failures.push(`${testCase.name}: ${error?.message?.split('\n')[0]}`);
    }
  }
  console.log(`CONFORMANCE passed=${cases.length - failures.length}/${cases.length} ms=${Math.round(performance.now() - suiteStart)}`);
  for (const failure of failures) console.log(`CONFORMANCE_FAIL ${failure}`);

  await timed('EXEC_TRUE', 200, () => base.exec(['true'], {}, context));
  await timed('FILE_INFO', 200, () => base.fileInfo('.', context));
  const big = new Uint8Array(8 * 1024 * 1024).fill(97);
  await timed('WRITE_8MIB', 5, () => base.writeFile('s13-big.bin', big, context));
  await timed('READ_8MIB', 5, () => base.readBinaryFile('s13-big.bin', context));
  await base.remove('s13-big.bin', { force: true }, context);

  // A dropped stream: the running command fails as lost, the next request starts a new daemon, and the
  // old daemon's process group is gone because its stdin ended.
  const sessionBefore = await connection.session();
  const sleeping = base.exec(['sh', '-c', 'echo $$ > s13-sleep.pid; exec sleep 37'], {}, context);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const cutAt = performance.now();
  cut();
  const lost = await sleeping;
  console.log(`LOST_RESULT ok=${lost.ok} code=${lost.error?.code} message=${JSON.stringify(lost.error?.message)} after_ms=${Math.round(performance.now() - cutAt)}`);
  assert.equal(lost.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const probe = await base.exec(['sh', '-c', 'if kill -0 "$(cat s13-sleep.pid)" 2>/dev/null; then echo alive; else echo gone; fi; rm -f s13-sleep.pid'], { onOutput: (text) => process.stdout.write(`CUT_COMMAND=${text}`) }, context);
  assert.ok(probe.ok, probe.error?.message);
  console.log(`SESSION_BEFORE=${sessionBefore} SESSION_AFTER=${await connection.session()}`);
  console.log(failures.length === 0 ? 'S13_PASS' : 'S13_CONFORMANCE_FAILURES');
} finally {
  connection.close();
  await ssh?.close();
  server?.close();
  await vm?.close();
}
