import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
const scratch = path.resolve(process.env.HOME, 'nexus-spikes');
if (process.cwd() !== scratch) throw new Error('Run only from scratch');
const start = Date.now();
const startedEpoch = Math.floor(start / 1000);
const node = path.join(scratch, 'tools/node-v24.22.1-linux-x64/bin/node');
const cli = 'node_modules/@earendil-works/gondolin/dist/bin/gondolin.js';
const variants = [
  { name: 'bookworm-slim-platform', image: 'debian:bookworm-slim' },
  { name: 'bookworm-platform', image: 'debian:bookworm' },
  { name: 'trixie-slim-platform', image: 'debian:trixie-slim' },
  { name: 'ubuntu2404-platform', image: 'ubuntu:24.04' },
  { name: 'bookworm-slim-lts', image: 'debian:bookworm-slim', alpine: { version: '3.23.0', kernelPackage: 'linux-lts', kernelImage: 'vmlinuz-lts' } },
];
const own = [{ tag: 'debian:bookworm-slim', id: fs.readFileSync('state/s12-pulled-image.txt', 'utf8').trim() }];
const results = [];
for (const variant of variants) {
  if (Date.now() - start > 20 * 60000) throw new Error('Supported-variation timebox exceeded');
  const existed = spawnSync('docker', ['image', 'inspect', variant.image], { stdio: 'ignore' }).status === 0;
  if (existed && !own.some(i => i.tag === variant.image)) {
    results.push({ name: variant.name, status: 'SKIPPED_PREEXISTING_IMAGE' });
    continue;
  }
  const config = { arch: 'x86_64', distro: 'alpine', oci: {
    image: variant.image, runtime: 'docker', pullPolicy: 'if-not-present', platform: 'linux/amd64',
  }, rootfs: { sizeMb: 6144 }, ...(variant.alpine ? { alpine: variant.alpine } : {}) };
  const configPath = `s1-${variant.name}.json`;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const log = fs.openSync(`logs/s1-${variant.name}.txt`, 'w');
  const t = Date.now();
  const r = spawnSync(node, [cli, 'build', '--config', configPath, '--output', `state/${variant.name}-assets`], {
    stdio: ['ignore', log, log], timeout: 240000, killSignal: 'SIGTERM',
  });
  fs.closeSync(log);
  const result = { name: variant.name, image: variant.image, seconds: (Date.now() - t) / 1000, status: r.status, signal: r.signal, error: r.error?.message };
  console.log(JSON.stringify(result));
  results.push(result);
  const id = spawnSync('docker', ['image', 'inspect', variant.image, '--format', '{{.Id}}'], { encoding: 'utf8' });
  if (!existed && id.status === 0) own.push({ tag: variant.image, id: id.stdout.trim() });
  fs.writeFileSync('state/s12-owned-images.json', JSON.stringify(own, null, 2));
  fs.writeFileSync('logs/s1-variant-results.json', JSON.stringify(results, null, 2));
  const text = fs.readFileSync(`logs/s1-${variant.name}.txt`, 'utf8');
  console.log(text.split('\n').slice(-8).join('\n'));
  if (r.status === 0) { console.log('SUCCESSFUL_VARIANT=' + variant.name); break; }
}
// Only read events for these permitted image names. Never inspect container commands/env.
const ids = new Set(fs.readFileSync('state/s12-created-containers.txt', 'utf8').trim().split('\n').filter(Boolean));
for (const { tag } of own) {
  const events = execFileSync('docker', ['events', '--since', String(startedEpoch), '--until', String(Math.floor(Date.now() / 1000) + 1),
    '--filter', 'type=container', '--filter', `image=${tag}`, '--format', '{{.Action}} {{.Actor.ID}}'], { encoding: 'utf8', timeout: 10000 });
  fs.appendFileSync('logs/s12-docker-events-variants.txt', `${tag}\n${events}`);
  for (const line of events.split('\n')) if (line.startsWith('create ')) ids.add(line.slice(7).trim());
}
fs.writeFileSync('state/s12-created-containers.txt', [...ids].sort().join('\n') + '\n');
console.log('TOTAL_CREATED_CONTAINER_IDS=' + ids.size);
