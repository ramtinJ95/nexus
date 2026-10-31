/**
 * The probe entrypoint: `node src/probe/main.ts [config]`, run by deploy/nexus-probe.service. The config
 * path defaults to /etc/nexus/probe.json.
 *
 * SIGTERM or SIGINT closes the server and aborts running jobs, which the next job converges from. It never
 * stops a pylon: each VM runs under a detached controller in its own session (launch in
 * src/pylon-vm/client.ts), with its own log file for stdio, so nothing the probe does on exit reaches it.
 * Under systemd, KillMode=process keeps the stop signal from reaching the rest of the unit's cgroup.
 * The exception is a shutdown or reboot of the node, which ends every VM with the rest of the system: the probe
 * pauses each running pylon first, and the next boot's probe marks them for a wake (shutdown.ts).
 * A second signal during the close kills the probe at once.
 */
import { createDockerBackend } from "../docker-backend.ts";
import { createPylonVmBackend } from "../pylon-vm-backend.ts";
import { localApiWhois } from "../tailscale.ts";
import { nodeSecrets, parseSelfDnsName, readProbeConfig, readSecretsFile, type ProbeConfig } from "./config.ts";
import { tailscaleCli } from "./serve.ts";
import { startProbe } from "./server.ts";
import { shutdownPauseMs, systemState } from "./shutdown.ts";

const config = await readProbeConfig(process.argv[2] ?? "/etc/nexus/probe.json");
// One source, so the probe's pre-boot check, the VMs and the control plane's handoffs see the same values.
const secrets = nodeSecrets(await readSecretsFile(config.secretsFile));
// `tailscale serve` as the probe's user needs `tailscale set --operator=nexus`, which deploy/install-probe.sh runs.
const tailscale = tailscaleCli();
// Read from tailscale rather than configured, so a preview URL always names the node the probe runs on.
const previewHost = config.previews === undefined ? {} : { previewHost: parseSelfDnsName(await tailscale(["status", "--json"], AbortSignal.timeout(30_000))) };
function pylonVm({ gitSsh, ...backend }: Extract<ProbeConfig["backend"], { kind: "pylon-vm" }>) {
  return createPylonVmBackend({ ...backend, secrets, ...previewHost, ...(gitSsh === undefined ? {} : { gitSsh }) });
}
function docker({ artifacts, ...backend }: Extract<ProbeConfig["backend"], { kind: "docker" }>) {
  return createDockerBackend({ ...backend, ...previewHost, ...(artifacts === undefined ? {} : { artifacts }) });
}
const probe = await startProbe({
  node: config.node,
  host: config.listen.host,
  port: config.listen.port,
  auth: config.auth,
  whois: localApiWhois(),
  backend: config.backend.kind === "pylon-vm" ? pylonVm(config.backend) : docker(config.backend),
  secrets,
  shutdownFile: config.shutdownFile,
  ...(config.previews === undefined ? {} : { previews: { ...config.previews, tailscale } }),
});
console.log(`probe ${config.node} listening on ${config.listen.host}:${probe.port} as boot ${probe.bootId}, ${config.backend.kind} backend`);

/** Only `stopping` drains, so a restart of the unit alone, as every deploy makes, leaves every pylon running. */
async function stop(signal: string) {
  const state = await systemState();
  if (state !== "stopping") {
    console.log(`${signal}: the system is ${state}, so closing the probe. Pylon VMs keep running`);
    return probe.close();
  }
  console.log(`${signal}: the system is stopping, so pausing every running pylon before closing the probe`);
  try {
    for (const outcome of await probe.drain(shutdownPauseMs)) {
      console.log("failed" in outcome ? `${outcome.pylonId}: not paused: ${outcome.failed}` : `${outcome.pylonId}: paused in ${outcome.pausedInMs} ms`);
    }
  } finally {
    await probe.close();
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    // Exits once closed rather than when the event loop drains: an aborted job can leave a backend CLI
    // call or poll running, and the next start converges from wherever it got to.
    stop(signal).then(() => process.exit(0), (err: unknown) => {
      console.error(err);
      process.exit(1);
    });
  });
}
