/**
 * The control plane this node trusts, in /etc/nexus/control-plane.json: its tailnet node ID and its URL. The probe and
 * the deployer both read it, so pointing a node at another control plane changes one file.
 * `node src/deploy/control-plane.ts check <etc dir>` refuses a file the deployer would refuse, before an upgrade installs.
 * `node src/deploy/control-plane.ts set <etc dir> <tailnet node ID> <url>` changes it and restarts the probe.
 * The bootstrap deployer and deploy/release.sh run it without node_modules, so it imports only Node's builtins and modules
 * that do too.
 */
import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { readJson, saveJson } from "../node-base/json-file.ts";
import { tailnetNodeIdPattern } from "../node-base/tailscaled.ts";
import { configFiles, unitNames } from "../node-base/node-layout.ts";
import { digestPattern } from "../protocol/deploy.ts";

export interface ControlPlane { tailnetNodeId: string; url: string }

const fileName = basename(configFiles.controlPlane);

export interface WorkerConfig {
  controlUrl: string;
  controlNodeId: string;
  token: string;
  drainTimeoutMs: number;
  healthTimeoutMs: number;
}
export function parseWorkerConfig(deployer: unknown, control: ControlPlane): WorkerConfig {
  const v = deployer as WorkerConfig;
  if (typeof v !== "object" || v === null || typeof v.token !== "string" || !digestPattern.test(v.token) ||
      !Number.isInteger(v.drainTimeoutMs) || v.drainTimeoutMs < 0 || v.drainTimeoutMs > 600_000 ||
      !Number.isInteger(v.healthTimeoutMs) || v.healthTimeoutMs < 1000 || v.healthTimeoutMs > 60_000) throw new Error("invalid deployer.json");
  return { controlUrl: control.url, controlNodeId: control.tailnetNodeId, token: v.token, drainTimeoutMs: v.drainTimeoutMs, healthTimeoutMs: v.healthTimeoutMs };
}

export function parseControlPlane(value: unknown): ControlPlane {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("must be a JSON object with tailnetNodeId and url");
  const unknown = Object.keys(value).filter((key) => key !== "tailnetNodeId" && key !== "url");
  if (unknown.length > 0) throw new Error(`has unknown keys ${unknown.join(", ")}. It holds only tailnetNodeId and url`);
  const { tailnetNodeId, url } = value as { tailnetNodeId?: unknown; url?: unknown };
  if (typeof tailnetNodeId !== "string" || !tailnetNodeIdPattern.test(tailnetNodeId)) {
    throw new Error(`tailnetNodeId must be the control plane's stable tailnet node ID, such as nAbCdEf1CNTRL, not ${JSON.stringify(tailnetNodeId)}`);
  }
  const origin = typeof url === "string" && URL.canParse(url) ? new URL(url) : undefined;
  if (origin === undefined || origin.protocol !== "http:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error(`url must be the control plane's tailnet HTTP origin, such as http://100.64.0.2:7470/, not ${JSON.stringify(url)}`);
  }
  return { tailnetNodeId, url: origin.href };
}

async function readAt(path: string): Promise<ControlPlane | undefined> {
  try {
    const value = await readJson(path);
    return value === undefined ? undefined : parseControlPlane(value);
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

export async function readControlPlane(path = configFiles.controlPlane): Promise<ControlPlane> {
  const control = await readAt(path);
  if (control === undefined) throw new Error(`${path} is missing. deploy/install.sh writes it, and so does deploy/set-control-plane.sh`);
  return control;
}

/**
 * Whoever can write the file picks whom the root deployer trusts, so it must belong to the user that reads it, root on a
 * node, and be writable by that user alone. The deployer refuses it otherwise, and so does the upgrade that checks it.
 */
export async function checkControlPlaneFile(path = configFiles.controlPlane): Promise<void> {
  const { uid, mode } = await stat(path);
  if (uid !== process.getuid?.() || (mode & 0o022) !== 0) throw new Error(`${path} must belong to root and be writable by root alone. Run sudo chown root:root ${path} && sudo chmod 0644 ${path}`);
}

/** Checks the file when it exists. A fresh machine has none until its install writes it. */
export async function checkExistingControlPlane(etc: string): Promise<ControlPlane | undefined> {
  const path = join(etc, fileName);
  const control = await readAt(path);
  if (control !== undefined) await checkControlPlaneFile(path);
  return control;
}

/** Points this node at `value`, restarting the probe only when the file changed. A file that does not parse is replaced. */
export async function setControlPlane(etc: string, value: ControlPlane, restart: () => Promise<void>): Promise<"wrote" | "unchanged"> {
  const control = parseControlPlane(value);
  const path = join(etc, fileName);
  const before = await readJson(path).catch(() => undefined);
  if (isDeepStrictEqual(before, control)) return "unchanged";
  await saveJson(path, control, { mode: 0o644 });
  try {
    await restart();
  } catch (err) {
    // The running probe still trusts what the file said, so the file says it again, and a retry starts over.
    if (before === undefined) await rm(path, { force: true });
    else await saveJson(path, before, { mode: 0o644 });
    throw err;
  }
  return "wrote";
}

// restart, not try-restart: a restart that failed after its stop leaves the probe down, and the retry must start it.
// Whether to restart follows from the unit's existence, not its enablement, so a probe started by hand restarts too. The
// deployer needs none: its timer's worker reads the file each poll.
async function restartProbe(): Promise<void> {
  const systemctl = async (args: string[]) => (await promisify(execFile)("systemctl", args)).stdout.trim();
  let loaded: string;
  try {
    loaded = await systemctl(["show", unitNames.probe, "--property=LoadState", "--value"]);
  } catch (err) {
    throw new Error(`could not tell whether this machine has a probe, so ${fileName} names the control plane it named before: ${(err as Error).message}`);
  }
  if (loaded === "not-found") return;
  try {
    await systemctl(["restart", unitNames.probe]);
  } catch (err) {
    throw new Error(`the probe did not restart, so ${fileName} names the control plane it named before: ${(err as Error).message}. Fix the restart and run this again, which restarts the probe whether it runs or not`);
  }
}

const describe = (control: ControlPlane) => `control plane ${control.tailnetNodeId} at ${control.url}`;

async function main(args: readonly string[]): Promise<number> {
  const [command, etc, ...rest] = args;
  if (command === "check" && etc !== undefined && rest.length === 0) {
    const control = await checkExistingControlPlane(etc);
    console.log(control === undefined ? `${etc} holds no ${fileName} yet` : `${join(etc, fileName)} names ${describe(control)}`);
    return 0;
  }
  if (command === "set" && etc !== undefined && rest.length === 2) {
    const [tailnetNodeId, url] = rest as [string, string];
    const path = join(etc, fileName);
    const control = parseControlPlane({ tailnetNodeId, url });
    const result = await setControlPlane(etc, control, restartProbe);
    console.log(result === "wrote" ? `wrote ${path}: ${describe(control)}, and restarted the probe` : `${path} already names ${describe(control)}`);
    return 0;
  }
  console.error("usage: node src/deploy/control-plane.ts check <etc dir> | set <etc dir> <tailnet node ID> <url>");
  return 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => {
    console.error(`control-plane: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
