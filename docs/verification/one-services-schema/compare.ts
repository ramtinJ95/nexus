/**
 * Runs each .nexus/services.yaml below through both real validators and prints whether each accepts it:
 * - nexus: parseServicesFile in src/project.ts, which the Docker backend reads the file with.
 * - pylon: GuestServices in src/pylon-vm/services.ts, the real pylon controller's supervisor, running the
 *   `ensure` every boot runs, against a guest whose only file is this one.
 * Then each ad hoc service through both boundaries of `nexus service start`:
 * - nexus: serviceDecl, which the in-pylon API parses the request with (src/probe/pylon-api.ts).
 * - pylon: the controller's `service-start` action (src/pylon-vm/contracts.ts actionSchema).
 * Exits with the number of cases where the two disagree.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { VM } from "@earendil-works/gondolin";
import { parseServicesFile, serviceDecl } from "../../../src/project.ts";
import { actionSchema } from "../../../src/pylon-vm/contracts.ts";
import { GuestServices } from "../../../src/pylon-vm/services.ts";

const svc = (fields: string): string => `services:\n  a: { command: x, ${fields} }\n`;
const files: [name: string, yaml: string][] = [
  ["review: false", svc("review: false")],
  ["cwd that leaves the repo", svc("cwd: ../shared")],
  ["absolute cwd", svc("cwd: /opt/app")],
  ["NEXUS_THREAD_ID in env", svc("env: { NEXUS_THREAD_ID: mine }")],
  ["NEXUS_FOO in env", svc("env: { NEXUS_FOO: mine }")],
  ["empty preview title", svc("preview: { title: '' }")],
  ["top-level version", "version: 1\nservices:\n  a: { command: x }\n"],
  ["top-level setup", "setup: [make]\nservices:\n  a: { command: x }\n"],
  ["keys 1 and '1'", "services:\n  1: { command: a }\n  '1': { command: b }\n"],
  ["reference to a service without a preview", "services:\n  a: { command: x }\n  b: { command: y, env: { U: '${services.a.publicURL}' } }\n"],
  ["unterminated reference", "services:\n  a: { command: x, preview: true }\n  b: { command: y, env: { U: '${services.a.publicURL' } }\n"],
  ["reference cycle", "services:\n  a: { command: x, preview: true, env: { U: '${services.a.publicURL}' } }\n"],
  ["control: the usage example", "services:\n  api: { command: x, cwd: apps/api, health: /healthz, preview: { title: API } }\n  web: { command: y, cwd: apps/web, preview: true, env: { API_URL: '${services.api.publicURL}' } }\n"],
  ["control: PORT in env", svc("env: { PORT: '1' }")],
];
const adHoc: [name: string, decl: Record<string, unknown>][] = [
  ["review: false", { command: "x", review: false }],
  ["cwd that leaves the repo", { command: "x", cwd: "../shared" }],
  ["absolute cwd", { command: "x", cwd: "/opt/app" }],
  ["NEXUS_THREAD_ID in env", { command: "x", env: { NEXUS_THREAD_ID: "mine" } }],
  ["empty preview title", { command: "x", preview: { title: "" } }],
  ["control: a plain service", { command: "x", cwd: "apps/a", preview: true }],
  ["control: PORT in env", { command: "x", env: { PORT: "1" } }],
];

type Verdict = { ok: true } | { ok: false; why: string };
const firstLine = (error: unknown): string => {
  if (error instanceof Error && "issues" in error) return (error.issues as { path: PropertyKey[]; message: string }[]).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  const lines = (error instanceof Error ? error.message : String(error)).split("\n").filter((l) => l.trim() !== "");
  return lines.slice(0, 3).join(" / ").replace(/\s+/g, " ");
};
const verdict = async (run: () => unknown): Promise<Verdict> => {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    return { ok: false, why: firstLine(error) };
  }
};
const zodVerdict = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): Verdict =>
  result.success ? { ok: true } : { ok: false, why: result.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };

/**
 * A guest whose only file is `yaml`. Every command it is asked to run succeeds, every port answers, each free port
 * asked for is the next from 41000, and its preview relay applies each map as it is written.
 */
function guestWith(yaml: string): VM {
  let nextPort = 41000;
  let relayStatus = "";
  return {
    async enableIngress() {
      return { url: "http://127.0.0.1:9/" };
    },
    setIngressRoutes() {},
    async exec(argv: string[], options: { stdout: Writable }) {
      const command = argv[3]!;
      const map = /relays\.json\.new' && mv /.test(command) ? /printf '%s' '([^']*)'/.exec(command) : null;
      if (map) {
        const { generation, relays } = JSON.parse(map[1]!);
        relayStatus = JSON.stringify({ generation, bound: relays, failed: {} });
      }
      if (command.startsWith("cat ") && command.includes("relay-status.json")) options.stdout.write(relayStatus);
      else if (command.includes("connect_ex")) options.stdout.write("True\n");
      else if (command.includes("getsockname")) options.stdout.write(`${nextPort++}\n`);
      return { exitCode: 0, stderr: JSON.stringify({ state: "exited", exitCode: 0 }) };
    },
    fs: {
      async stat() {
        return { size: Buffer.byteLength(yaml) };
      },
      async readFile() {
        return yaml;
      },
      async writeFile() {},
    },
  } as unknown as VM;
}

async function pylonReads(yaml: string): Promise<Verdict> {
  const dir = await mkdtemp(join(tmpdir(), "compare-"));
  const services = new GuestServices(guestWith(yaml), dir, "/workspace/repo/.nexus/services.yaml", "/workspace/repo", "user", { a: "https://a.example/", api: "https://api.example/" });
  try {
    return await verdict(() => services.operate("ensure"));
  } finally {
    await services.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const show = (v: Verdict): string => (v.ok ? "accepts" : `refuses (${v.why})`);
let disagreements = 0;
function report(name: string, nexus: Verdict, pylon: Verdict): void {
  const agree = nexus.ok === pylon.ok;
  if (!agree) disagreements++;
  console.log(`${agree ? "agree   " : "DISAGREE"}  ${name}\n          nexus: ${show(nexus)}\n          pylon: ${show(pylon)}`);
}

console.log("== .nexus/services.yaml: parseServicesFile (nexus, Docker backend) vs GuestServices (real pylon)\n");
for (const [name, yaml] of files) {
  console.log(yaml.trimEnd().replace(/^/gm, "          | "));
  report(name, await verdict(() => parseServicesFile(yaml)), await pylonReads(yaml));
}
console.log("\n== nexus service start: the in-pylon API's serviceDecl (nexus) vs the controller's service-start action (pylon)\n");
for (const [name, decl] of adHoc) {
  console.log(`          | ${JSON.stringify(decl)}`);
  report(name, zodVerdict(serviceDecl.safeParse(decl)), zodVerdict(actionSchema.safeParse({ action: "service-start", name: "pylon-1", service: "a", ...decl })));
}
console.log(`\n${disagreements} disagreement(s)`);
process.exitCode = Math.min(disagreements, 125);
