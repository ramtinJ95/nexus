/**
 * The host command that mints a join token, which `sudo deploy/install.sh --join-token` runs from the control plane's
 * release. Only root runs it, so an agent, which can call the API as the person's Mac but never run a command as root on
 * the control plane's machine, cannot add a node. It acts as the registry's owner, so the files SQLite creates stay the
 * control plane's.
 *
 *   sudo node src/control/join-token.ts <config.json>
 */
import { statSync } from "node:fs";
import { mintJoinToken } from "./join.ts";
import { readConfig } from "./main.ts";
import { openRegistry } from "./registry.ts";

async function host(args: string[]) {
  const [configPath] = args;
  if (configPath === undefined || args.length !== 1) {
    console.error("usage: sudo node src/control/join-token.ts <config.json>");
    process.exit(64);
  }
  if (process.getuid?.() !== 0) {
    console.error("join-token: run this as root on the control plane's machine. A join token adds a node, so only root may mint one");
    process.exit(77);
  }
  const config = await readConfig(configPath);
  const owner = statSync(config.db);
  process.setgid!(owner.gid);
  process.setuid!(owner.uid);
  const registry = openRegistry(config.db);
  try {
    const { token, expiresAt } = mintJoinToken(registry);
    const self = config.nodes.find((n) => n.tailnetNodeId === config.self.tailnetNodeId)?.name ?? config.listen.hostnames[0]!;
    console.log(`On the new machine, in a nexus checkout, run:\n\n  sudo deploy/install.sh --join ${token} --node ${self}\n\nThe token joins one machine until ${new Date(expiresAt).toISOString()}.`);
  } finally {
    registry.close();
  }
}

if (import.meta.main) await host(process.argv.slice(2));
