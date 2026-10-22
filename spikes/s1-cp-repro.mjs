// Minimal isolated reproduction; does not import or modify Gondolin.
import fs from 'node:fs';
import path from 'node:path';
const scratch = path.resolve(process.env.HOME, 'nexus-spikes');
if (process.cwd() !== scratch) throw new Error('Run only in ~/nexus-spikes');
const mode = process.argv[2] ?? 'default';
if (!['default', 'verbatim'].includes(mode)) throw new Error('Unknown mode');
const dir = fs.mkdtempSync(path.join(scratch, 'tmp/cp-repro-'));
const src = path.join(dir, 'src');
const dest = path.join(dir, 'dest');
fs.mkdirSync(src);
fs.symlinkSync('/boot/vmlinuz-virt', path.join(src, 'vmlinuz'));
console.log(JSON.stringify({ node: process.version, mode, dir, link: fs.readlinkSync(path.join(src, 'vmlinuz')) }));
fs.cpSync(src, dest, { recursive: true, dereference: false, ...(mode === 'verbatim' ? { verbatimSymlinks: true } : {}) });
console.log('COPIED_LINK=' + fs.readlinkSync(path.join(dest, 'vmlinuz')));
