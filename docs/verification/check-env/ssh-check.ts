/**
 * Runs gate.ts's checkScript at a checkout through a pylon's own sshd, as pylonGuest's stream runs it in a check
 * thread, and prints its output and the pipe's exit status.
 *
 *   node docs/verification/check-env/ssh-check.ts <identity file> <checkout>
 *
 * The identity file's public key must be in the pylon user's ~/.ssh/authorized_keys.
 */
import { execFileSync } from "node:child_process";
import { checkScript } from "../../../src/control/gate.ts";
import { processStream } from "../../../src/process-stream.ts";
import { guestSsh, remoteCommand } from "../../../src/pylon-vm/pylon-guest.ts";
import { checkoutDir } from "../../../src/sessions.ts";

const [identityFile, checkout] = process.argv.slice(2);
if (identityFile === undefined || checkout === undefined) throw new Error("usage: ssh-check.ts <identity file> <checkout>");
const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const argv = ["sh", "-c", checkScript.replaceAll(checkoutDir, checkout), "nexus-check", head];
const stream = processStream("ssh", [...guestSsh({ access: { user: "user", port: 22, identityFile } }), "--", remoteCommand(argv)], (text) => process.stderr.write(text));
await stream.close();
for await (const chunk of stream) process.stdout.write(chunk);
console.log(`\nexit: ${JSON.stringify(await stream.done)}`);
