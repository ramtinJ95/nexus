/**
 * The control plane this node trusts, in /etc/nexus/control-plane.json: its tailnet node ID and its URL. The probe and
 * the deployer both read it, so pointing a node at another control plane changes one file.
 * `node src/deploy/control-plane.ts adopt <etc dir>` writes it once from what probe.json and deployer.json named before it.
 * `node src/deploy/control-plane.ts set <etc dir> <tailnet node ID> <url>` changes it and restarts a running probe.
 * The bootstrap deployer and deploy/release.sh run it without node_modules, so it imports only Node's builtins and modules
 * that do too.
 */
import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { readJson, saveJson } from "../json-file.ts";
import { tailnetNodeIdPattern } from "../tailscale.ts";

export interface ControlPlane { tailnetNodeId: string; url: string }

export const controlPlanePath = "/etc/nexus/control-plane.json";
const fileName = basename(controlPlanePath);

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

/** Undefined when there is no file. */
async function readAt(path: string): Promise<ControlPlane | undefined> {
  try {
    const value = await readJson(path);
    return value === undefined ? undefined : parseControlPlane(value);
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

export async function readControlPlane(path = controlPlanePath): Promise<ControlPlane> {
  const control = await readAt(path);
  if (control === undefined) throw new Error(`${path} is missing. deploy/install.sh writes it, and so does deploy/set-control-plane.sh`);
  return control;
}

/** The control plane probe.json's auth.controlPlane and deployer.json's controlNodeId and controlUrl named before this file. */
export function legacyControlPlane(probe: unknown, deployer: unknown): ControlPlane {
  const trusted = (probe as { auth?: { controlPlane?: unknown } } | null | undefined)?.auth?.controlPlane;
  const { controlNodeId, controlUrl } = (deployer ?? {}) as { controlNodeId?: unknown; controlUrl?: unknown };
  if (trusted === undefined) throw new Error("probe.json names no control plane in auth.controlPlane");
  if (controlNodeId === undefined) throw new Error("deployer.json names no control plane in controlNodeId");
  if (trusted !== controlNodeId) {
    throw new Error(`probe.json's auth.controlPlane ${JSON.stringify(trusted)} and deployer.json's controlNodeId ${JSON.stringify(controlNodeId)} name different control planes. Name the one to trust with deploy/set-control-plane.sh`);
  }
  try {
    return parseControlPlane({ tailnetNodeId: trusted, url: controlUrl });
  } catch (err) {
    throw new Error(`probe.json and deployer.json name no usable control plane: ${(err as Error).message}`);
  }
}

/**
 * Whoever can write the file picks whom the root deployer trusts, so it must belong to the user that reads it, root on a
 * node, and be writable by that user alone. The deployer refuses it otherwise, and so does the install that adopts it.
 */
export async function checkControlPlaneFile(path = controlPlanePath): Promise<void> {
  const { uid, mode } = await stat(path);
  if (uid !== process.getuid?.() || (mode & 0o022) !== 0) throw new Error(`${path} must belong to root and be writable by root alone. Run sudo chown root:root ${path} && sudo chmod 0644 ${path}`);
}

/**
 * The upgrade to this file. Once it exists, probe.json's and deployer.json's old keys are ignored, even when they
 * disagree with it. With neither of those either, this is a fresh machine, whose install writes it.
 */
export async function adoptControlPlane(etc: string): Promise<"wrote" | "kept" | "none"> {
  const path = join(etc, fileName);
  if (await readAt(path) !== undefined) {
    await checkControlPlaneFile(path);
    return "kept";
  }
  const legacy = async (name: string) => {
    try {
      return await readJson(join(etc, name));
    } catch (err) {
      throw new Error(`${join(etc, name)}: ${(err as Error).message}`);
    }
  };
  const [probe, deployer] = [await legacy("probe.json"), await legacy("deployer.json")];
  if (probe === undefined && deployer === undefined) return "none";
  await saveJson(path, legacyControlPlane(probe, deployer), { mode: 0o644 });
  return "wrote";
}

/**
 * Points this node at `value`, restarting the probe only when the file changed. A file that does not parse is replaced.
 * The old keys probe.json and deployer.json still hold follow it, because a rollback's probe and a bootstrap worker from
 * before the file read them, and must trust the same control plane as the file.
 */
export async function setControlPlane(etc: string, value: ControlPlane, restart: () => Promise<void>): Promise<"wrote" | "unchanged"> {
  const control = parseControlPlane(value);
  const path = join(etc, fileName);
  const followed = await oldKeyWrites(etc, control);
  const before = await readJson(path).catch(() => undefined);
  const changed = !isDeepStrictEqual(before, control);
  for (const write of followed) await saveJson(write.path, write.value, { mode: write.mode });
  // Last, so a failure before it leaves the file as it was, and a retry still restarts the probe onto the new one.
  if (changed) {
    await saveJson(path, control, { mode: 0o644 });
    try {
      await restart();
    } catch (err) {
      // The running probe still trusts what the file said, so the file says it again until a restart succeeds.
      if (before === undefined) await rm(path, { force: true });
      else await saveJson(path, before, { mode: 0o644 });
      throw err;
    }
  }
  return changed || followed.length > 0 ? "wrote" : "unchanged";
}

type Old = Record<string, unknown>;
const oldKeys: readonly [string, (old: Old, control: ControlPlane) => Old][] = [
  ["probe.json", (old, control) => typeof old.auth === "object" && old.auth !== null && "controlPlane" in old.auth
    ? { ...old, auth: { ...old.auth, controlPlane: control.tailnetNodeId } } : old],
  ["deployer.json", (old, control) => ({
    ...old,
    ..."controlNodeId" in old ? { controlNodeId: control.tailnetNodeId } : {},
    ..."controlUrl" in old ? { controlUrl: control.url } : {},
  })],
];

/** The rewrites of the old keys each file still has, keeping its mode. Every file is read before anything is written. */
async function oldKeyWrites(etc: string, control: ControlPlane): Promise<{ path: string; value: Old; mode: number }[]> {
  const writes: { path: string; value: Old; mode: number }[] = [];
  for (const [name, follow] of oldKeys) {
    const path = join(etc, name);
    let old: unknown;
    try {
      old = await readJson(path);
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}. Nothing was changed`);
    }
    if (typeof old !== "object" || old === null || Array.isArray(old)) continue;
    const value = follow(old as Old, control);
    if (!isDeepStrictEqual(old, value)) writes.push({ path, value, mode: (await stat(path)).mode & 0o777 });
  }
  return writes;
}

// try-restart never starts a stopped probe. The deployer needs none: its timer runs a worker that reads the file each poll.
async function restartProbe(): Promise<void> {
  try {
    await promisify(execFile)("systemctl", ["try-restart", "nexus-probe.service"]);
  } catch (err) {
    throw new Error(`the probe did not restart, so ${fileName} names the control plane it trusts again: ${(err as Error).message}. Fix the restart and run this again`);
  }
}
const describe = (control: ControlPlane) => `control plane ${control.tailnetNodeId} at ${control.url}`;

async function main(args: readonly string[]): Promise<number> {
  const [command, etc, ...rest] = args;
  if (command === "adopt" && etc !== undefined && rest.length === 0) {
    const path = join(etc, fileName);
    const result = await adoptControlPlane(etc);
    if (result === "none") console.log(`${etc} holds no probe.json or deployer.json to write ${fileName} from`);
    else console.log(`${result === "wrote" ? `wrote ${path} from probe.json and deployer.json:` : `${path} names`} ${describe(await readControlPlane(path))}`);
    return 0;
  }
  if (command === "set" && etc !== undefined && rest.length === 2) {
    const [tailnetNodeId, url] = rest as [string, string];
    const path = join(etc, fileName);
    const control = parseControlPlane({ tailnetNodeId, url });
    const result = await setControlPlane(etc, control, restartProbe);
    console.log(result === "wrote" ? `wrote ${path}: ${describe(control)}, and restarted the probe if it was running` : `${path} already names ${describe(control)}`);
    return 0;
  }
  console.error("usage: node src/deploy/control-plane.ts adopt <etc dir> | set <etc dir> <tailnet node ID> <url>");
  return 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => {
    console.error(`control-plane: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
