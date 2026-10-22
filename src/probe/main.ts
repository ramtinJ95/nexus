/**
 * The probe entrypoint: `node src/probe/main.ts [config]`, run by deploy/nexus-probe.service. The config
 * path defaults to /etc/nexus/probe.json.
 *
 * SIGTERM or SIGINT closes the server and aborts running jobs, which the next job converges from. It never
 * stops a pylon: each VM runs under a detached controller in its own session (launch in
 * src/pylon-vm/client.ts), with its own log file for stdio, so nothing the probe does on exit reaches it.
 * Under systemd, KillMode=process keeps the stop signal from reaching the rest of the unit's cgroup.
 * A second signal during the close kills the probe at once.
 */
import { createDockerBackend } from "../docker-backend.ts";
import { createPylonVmBackend } from "../pylon-vm-backend.ts";
import { localApiWhois } from "../tailscale.ts";
import { readProbeConfig, readSecretsFile } from "./config.ts";
import { startProbe } from "./server.ts";

const config = await readProbeConfig(process.argv[2] ?? "/etc/nexus/probe.json");
const probe = await startProbe({
  node: config.node,
  host: config.listen.host,
  port: config.listen.port,
  auth: config.auth,
  whois: localApiWhois(),
  backend: config.backend.kind === "pylon-vm" ? createPylonVmBackend(config.backend) : createDockerBackend(config.backend),
  secrets: await readSecretsFile(config.secretsFile),
});
console.log(`probe ${config.node} listening on ${config.listen.host}:${probe.port} as boot ${probe.bootId}, ${config.backend.kind} backend`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`${signal}: closing the probe. Pylon VMs keep running`);
    // Exits once closed rather than when the event loop drains: an aborted job can leave a backend CLI
    // call or poll running, and the next start converges from wherever it got to.
    probe.close().then(() => process.exit(0), (err: unknown) => {
      console.error(err);
      process.exit(1);
    });
  });
}
