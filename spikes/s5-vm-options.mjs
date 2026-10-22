import { s2Hosts, vmOptions } from './s12-vm-options.mjs';
export { checkpointPath } from './s12-vm-options.mjs';

export const guestPath = '/home/user/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin';
export const guestCa = '/run/gondolin/ca-certificates.crt';
export const s5Hosts = [...new Set([...s2Hosts, 'registry.npmjs.org', 'auth.openai.com', 'chatgpt.com', 'api.openai.com'])];
export function s5Options() {
  // Installed Gondolin 0.13.0 has no dedicated createHttpHooks deny callback.
  // Keep S2's hostname-only isIpAllowed reporting; do not log URLs or headers.
  console.log('DENY_CALLBACK_UNAVAILABLE: Gondolin 0.13.0; no s5-blocked-hosts.log. EGRESS_DENY remains on stdout.');
  const options = vmOptions(s5Hosts);
  return { ...options, sessionLabel: 'nexus-s5-pi',
    env: { ...options.env, PATH: guestPath, NODE_EXTRA_CA_CERTS: guestCa } };
}
