/**
 * check-ca.ts <dir with package.json and package-lock.json>: runs `npm ci` there with a cold cache, as the review
 * loop's check does, through a shell without NODE_EXTRA_CA_CERTS, as sshd starts a stream's command. Once with the
 * argv quoted alone, as streams did, and once through remoteCommand.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteCommand } from "../../../../src/pylon-vm/pylon-guest.ts";
import { shellQuote } from "../../../../src/pylon-vm/storage.ts";

const dir = process.argv[2]!;
for (const [label, command] of [["argv alone", (argv: string[]) => argv.map(shellQuote).join(" ")], ["remoteCommand", remoteCommand]] as const) {
  const cache = await mkdtemp(join(tmpdir(), "nexus-npm-cache-"));
  await rm(join(dir, "node_modules"), { recursive: true, force: true });
  const result = spawnSync("env", ["-u", "NODE_EXTRA_CA_CERTS", "sh", "-c", command(["npm", "ci", "--no-audit", "--no-fund", "--cache", cache])], { cwd: dir, encoding: "utf8" });
  const lines = (result.stdout + result.stderr).split("\n").filter((line) => /npm error (code|request)|^added/.test(line));
  console.log(`${label}: exit ${result.status}\n${lines.map((line) => `  ${line}`).join("\n")}`);
  await rm(cache, { recursive: true, force: true });
}
