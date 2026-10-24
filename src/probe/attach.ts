/**
 * The node side of `nexus attach`: `node src/probe/attach.ts <probe config> <pylon>` gives the terminal it runs in
 * to the pylon's Herdr session, until the person detaches. deploy/nexus-attach runs it as the probe's user, which
 * alone may use the pylons' control sockets, for a person who reached the node over ssh.
 *
 * A pylon VM's controller enables the guest's sshd for `user` with its `shell` action, as the probe's streams do,
 * and this runs ssh with a terminal to it. A Docker pylon is a container named after the pylon, which `docker exec`
 * reaches. Either way the guest runs attachScript, which counts as a human's presence while it stays attached.
 */
import { spawn } from "node:child_process";
import { run } from "../pylon-vm/client.ts";
import { guestSsh, shellReplySchema } from "../pylon-vm/pylon-guest.ts";
import { attachScript } from "../sessions.ts";
import { readProbeConfig } from "./config.ts";

/** The pylon of a thread, as the control plane names it. Anything else never reaches a command line. */
const pylonPattern = /^pylon-th-[0-9a-f]{12}$/;

async function main(argv: readonly string[]): Promise<number> {
  const [configPath, pylonId] = argv;
  if (configPath === undefined || pylonId === undefined || argv.length !== 2) return fail("usage: attach.ts <probe config> <pylon>");
  if (!pylonPattern.test(pylonId)) return fail(`${pylonId} is not a pylon ID, such as pylon-th-0123456789ab`);
  if (!process.stdin.isTTY) return fail("attaching needs a terminal. Over ssh, pass -t");
  const config = await readProbeConfig(configPath);
  if (config.backend.kind === "docker") return attach("docker", ["exec", "--interactive", "--tty", pylonId, "sh", "-c", attachScript]);
  let shell: unknown;
  try {
    shell = await run(config.backend.stateRoot, { action: "shell", name: pylonId, user: "user" });
  } catch (err) {
    return fail(`${pylonId} on ${config.node} gives no terminal: ${(err as Error).message}`, 1);
  }
  // sshd hands the remote command to user's login shell.
  return attach("ssh", [...guestSsh(shellReplySchema.parse(shell), true), "--", attachScript]);
}

function attach(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function fail(message: string, code = 64): number {
  process.stderr.write(`nexus-attach: ${message}\n`);
  return code;
}

process.exitCode = await main(process.argv.slice(2));
