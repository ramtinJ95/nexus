/**
 * The host command that makes passkey enrolment codes, and lists and revokes passkeys. Only root runs it, so an agent,
 * which can call the API but never run a command as root on the control plane's host, cannot make a code. It acts as
 * the registry's owner, so the files SQLite creates stay the control plane's.
 *
 *   sudo node src/control/passkeys-host.ts <config.json> code | list | revoke <id>
 */
import { statSync } from "node:fs";
import { readConfig } from "./main.ts";
import { newCode, passkeyList } from "./passkeys.ts";
import { openRegistry } from "./registry.ts";

async function host(args: string[]) {
  const [configPath, command, id] = args;
  const usage = "usage: sudo node src/control/passkeys-host.ts <config.json> code | list | revoke <id>";
  if (configPath === undefined || !["code", "list", "revoke"].includes(command ?? "") || (command === "revoke") !== (id !== undefined)) {
    console.error(usage);
    process.exit(64);
  }
  if (process.getuid?.() !== 0) {
    console.error("passkeys: run this as root on the control plane's host. The code it makes is what lets a passkey enrol, so only root may make one");
    process.exit(77);
  }
  const config = await readConfig(configPath);
  const owner = statSync(config.db);
  process.setgid!(owner.gid);
  process.setuid!(owner.uid);
  const registry = openRegistry(config.db);
  try {
    if (command === "code") {
      const { code, expiresAt } = newCode(registry);
      const url = config.https === undefined ? null : `https://${config.https.hostname}:7443/passkeys?code=${code}`;
      console.log(`${url ?? code}\nThe code ${code} enrols one passkey until ${new Date(expiresAt).toISOString()}.${url === null ? " The config has no https.hostname, so the dashboard cannot enrol it yet." : ""}`);
    } else if (command === "list") {
      const list = passkeyList(registry);
      console.log(list.length === 0 ? "No passkeys." : list.map((p) => `${p.id}  ${p.name}  enrolled ${new Date(p.createdAt).toISOString()} from ${p.createdBy}${p.lastUsedAt === null ? "" : `, last used ${new Date(p.lastUsedAt).toISOString()}`}`).join("\n"));
    } else {
      const revoked = registry.revokePasskey(id!, "root on the control plane's host");
      if (revoked === null) {
        console.error(`passkeys: no passkey ${id}`);
        process.exit(1);
      }
      console.log(`Revoked ${revoked.id}, ${revoked.name}.`);
    }
  } finally {
    registry.close();
  }
}

if (import.meta.main) await host(process.argv.slice(2));
