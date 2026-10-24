// Screenshots of the dashboard's New project flow against a throwaway control plane: the real API and dashboard
// on a fresh registry with no projects, a fake harness, and two nodes, one online. Each step asserts what the page
// shows before its screenshot, and the script exits non-zero on the first that does not hold. Needs local port
// binding and the global playwright-cli. Screenshots go to .verify/new-project-shots/. Run from the repo root:
// node .claude/skills/verify-nexus/scripts/new-project-shots.ts
// playwright-cli runs asynchronously, because this process also serves the dashboard it drives.
import { isDeepStrictEqual, promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startApi } from "../../../../src/control/api.ts";
import { fakeHarness } from "../../../../src/control/fake-harness.ts";
import { openRegistry } from "../../../../src/control/registry.ts";
import type { NodeName, TailnetNodeId } from "../../../../src/protocol.ts";
import type { ProjectId } from "../../../../src/project.ts";

const out = join(import.meta.dirname, "../../../../.verify/new-project-shots");
mkdirSync(out, { recursive: true });
const port = 7490;
const base = `http://127.0.0.1:${port}`;
const laptop = "nLAPTOP" as TailnetNodeId;

const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-shots-")), "registry.db"));
const online = "rj-firebat" as NodeName;
registry.upsertNode({ name: "infra-testbench" as NodeName, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: "nTESTBENCH" as TailnetNodeId });
registry.upsertNode({ name: online, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
registry.apply({ record: "node", node: online, state: "online", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 } });

const api = await startApi({
  registry, host: "127.0.0.1", port,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "git@github.com:ramtin/dotfiles.git", ref: "main" },
  harness: fakeHarness().harness, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});
const post = async (method: string, path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
};
// A current image, so the start dialog that opens after the add has no warning in it.
const image = "img-0123456789ab";
await post("POST", "/v1/images", {
  id: image, gondolinBuildId: "b1", builtOn: online, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
  },
});
await post("PUT", "/v1/images/current", { image });

const session = "-s=nexus-new-project";
const playwright = (args: string[]) => promisify(execFile)("playwright-cli", [session, ...args], { cwd: out, encoding: "utf8" });
async function pw(...args: string[]): Promise<void> {
  console.log(`playwright-cli ${args.join(" ")}`);
  const { stdout, stderr } = await playwright(args);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}
const shot = (name: string) => pw("screenshot", "--filename", `${name}.png`);

/** What the page shows of the flow, read in the browser. */
interface View {
  path: string;
  projectOpen: boolean;
  projectError: string | null;
  node: string | null;
  branch: string | null;
  startOpen: boolean;
  startEmpty: boolean;
  checked: string | null;
  sidebar: string[];
}
const read = `() => {
  const error = document.getElementById("project-error");
  return JSON.stringify({
    path: location.pathname,
    projectOpen: document.getElementById("project-dialog").open,
    projectError: error === null || error.hidden ? null : error.textContent,
    node: document.getElementById("project-node")?.value ?? null,
    branch: document.getElementById("project-branch")?.value ?? null,
    startOpen: document.getElementById("start-dialog").open,
    startEmpty: document.querySelector("#start-body [data-new-project]") !== null,
    checked: document.querySelector("#start input[name=project]:checked")?.value ?? null,
    sidebar: [...document.querySelectorAll("#side-threads .group-h span:first-child")].map((s) => s.textContent),
  });
}`;
async function view(): Promise<View> {
  const parsed: unknown = JSON.parse((await playwright(["--raw", "eval", read])).stdout.trim());
  return (typeof parsed === "string" ? JSON.parse(parsed) : parsed) as View;
}
/** Waits up to 10 s for the page to show `expected`, and fails with what it shows instead. */
async function expect(what: string, expected: Partial<View>): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const v = await view();
    if (Object.entries(expected).every(([k, want]) => isDeepStrictEqual(v[k as keyof View], want))) {
      console.log(`ok: ${what}`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`expected ${what}: ${JSON.stringify(expected)}, but the page shows ${JSON.stringify(v)}`);
    await sleep(250);
  }
}
/** The API's own answer to a body, which the dialog must show word for word. */
async function refusal(body: unknown): Promise<string> {
  const res = await fetch(`${base}/v1/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) throw new Error(`expected the API to refuse ${JSON.stringify(body)}`);
  return ((await res.json()) as { error: string }).error;
}
const repoUrl = "git@github.com:octocat/Hello-World.git";
const cliDefaults = { defaultBranch: "main", resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null };

try {
  await pw("open", `${base}/`);
  await pw("resize", "1280", "800");
  await expect("an empty home with both dialogs closed", { path: "/", projectOpen: false, startOpen: false, sidebar: [] });
  await shot("1-empty-home");

  await pw("goto", `${base}/threads/new`);
  await expect("the start dialog offering a new project", { startOpen: true, startEmpty: true });
  await shot("2-empty-start-dialog");

  await pw("click", "#start-body [data-new-project]");
  await expect("the new-project dialog in place of the start dialog, on the first online node and main",
    { projectOpen: true, startOpen: false, projectError: null, node: online, branch: "main" });
  await shot("3-new-project-dialog");

  await pw("fill", "#project-id", "My App");
  await pw("fill", "#project-repo", repoUrl);
  await shot("4-filled-form");

  const invalid = await refusal({ id: "My App", repoUrl, defaultNode: online, ...cliDefaults });
  await pw("click", "#project button[type=submit]");
  await expect("the API's 400 in the dialog, which stays open", { projectOpen: true, projectError: invalid });
  await shot("5-error-invalid-id");

  await pw("fill", "#project-id", "acme");
  await pw("click", "#project button[type=submit]");
  await expect("the start dialog open on the new project, listed in the sidebar",
    { projectOpen: false, startOpen: true, checked: "acme", sidebar: ["acme"] });
  if (!isDeepStrictEqual(registry.project("acme" as ProjectId), { id: "acme", repoUrl, defaultNode: online, ...cliDefaults })) {
    throw new Error(`the added project is not the CLI's: ${JSON.stringify(registry.project("acme" as ProjectId))}`);
  }
  console.log("ok: the added project has the CLI's defaults");
  await shot("6-success-start-dialog");

  await pw("goto", `${base}/projects/new`);
  await expect("the new-project dialog, opened by its URL", { projectOpen: true, startOpen: false });
  await pw("fill", "#project-id", "acme");
  await pw("fill", "#project-repo", repoUrl);
  await pw("click", "#project button[type=submit]");
  await expect("the API's 409 in the dialog, which stays open", { projectOpen: true, projectError: "project acme exists" });
  await shot("7-error-exists");

  await pw("press", "Escape");
  await expect("home with the project and the URL back at /", { path: "/", projectOpen: false, sidebar: ["acme"] });
  await shot("8-home-with-project");

  await pw("resize", "390", "844");
  await pw("goto", `${base}/projects/new`);
  await expect("the new-project dialog on a phone", { projectOpen: true });
  await shot("9-phone-dialog");
  console.log(`all checks passed, screenshots in ${out}`);
} finally {
  await pw("close").catch(() => {});
  await api.close();
  registry.close();
}
