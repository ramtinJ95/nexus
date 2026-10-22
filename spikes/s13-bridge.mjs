// The program pi-env's Connection starts in place of the daemon. Connection appends `serve --token <hex>`,
// and this forwards those arguments to whatever carries the byte stream, as the Nexus pylon bridge will.
//   s13-bridge.mjs spawn <daemon>   pump through this process to a local daemon (sandbox-friendly)
//   s13-bridge.mjs socket <path>    send the arguments as one JSON line, then pump through a Unix socket
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import net from 'node:net';

const [mode, target, ...serveArgs] = process.argv.slice(2);
if (process.env.S13_BRIDGE_PIDFILE) writeFileSync(process.env.S13_BRIDGE_PIDFILE, String(process.pid));
if (mode === 'spawn') {
  const daemon = spawn(target, serveArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
  process.stdin.on('data', (chunk) => daemon.stdin.write(chunk));
  process.stdin.on('end', () => daemon.stdin.end());
  daemon.stdout.on('data', (chunk) => process.stdout.write(chunk));
  daemon.on('exit', (code) => process.exit(code ?? 1));
} else if (mode === 'socket') {
  const socket = net.connect(target);
  socket.write(JSON.stringify(serveArgs) + '\n');
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on('close', () => process.exit(0));
  socket.on('error', (error) => { process.stderr.write(`bridge: ${error.message}\n`); process.exit(1); });
} else {
  process.stderr.write(`bridge: unknown mode ${mode}\n`);
  process.exit(2);
}
