import path from 'node:path';
import { createHttpHooks } from '@earendil-works/gondolin';
export const s2Hosts = ['api.anthropic.com', 'claude.ai', 'claude.com', 'platform.claude.com', 'downloads.claude.ai', 'registry.npmjs.org'];
export const provisionHosts = [...s2Hosts, 'deb.debian.org', 'security.debian.org', 'nodejs.org', 'herdr.dev', 'github.com', 'release-assets.githubusercontent.com'];
export function vmOptions(hosts = s2Hosts) {
  const { httpHooks } = createHttpHooks({ allowedHosts: hosts });
  const original = httpHooks.isIpAllowed;
  const seen = new Set();
  httpHooks.isIpAllowed = async info => {
    const allowed = await original(info);
    const key = `${allowed ? 'EGRESS_ALLOW' : 'EGRESS_DENY'} ${info.hostname}`;
    if (!seen.has(key)) { console.log(key); seen.add(key); }
    return allowed;
  };
  return { sandbox: { vmm: 'qemu', accel: 'kvm', imagePath: path.resolve('state/debian-assets') },
    rootfs: { mode: 'cow' }, memory: '3G', cpus: 2, startTimeoutMs: 60000,
    env: { PATH: '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin', TERM: 'xterm-256color' },
    sessionLabel: 'nexus-s12-debian', httpHooks };
}
export const checkpointPath = path.resolve('state/s2-debian.qcow2');
