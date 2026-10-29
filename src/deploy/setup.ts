/**
 * Writes /etc/nexus/{control,probe,deployer}.json for `deploy/install.sh`, gives the agents their credentials
 * (src/deploy/credentials.ts) and says what is left for the person: `node src/deploy/setup.ts write|credentials|left
 * [--node <control device>] [--admit <device>]... [--add-node <device>=<digest>]... [--peer <device>]...
 * [--dotfiles <git url>] [--non-interactive] [--github-watch]`. It runs as root from a checkout before `npm ci`, so it imports only
 * Node's builtins.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify, isDeepStrictEqual, parseArgs } from "node:util";
import { claudeNames, gitKnownHosts, locations, provision, scripted, secretNames, stores, system, terminal, type FollowUp } from "./credentials.ts";

const exec = promisify(execFile);

export const paths = {
  control: "/etc/nexus/control.json",
  probe: "/etc/nexus/probe.json",
  deployer: "/etc/nexus/deployer.json",
  secrets: stores.claude.file,
  gitKey: stores.gitKey.file,
  gitKnownHosts,
  artifacts: "/var/lib/nexus/artifacts",
} as const;

export const controlPort = 7470;

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

export interface Device { id: string; name: string; host: string; ip: string }
export interface Tailnet { self: Device; peers: readonly Device[] }

function device(raw: unknown): Device | undefined {
  const { ID, DNSName, TailscaleIPs } = (raw ?? {}) as { ID?: unknown; DNSName?: unknown; TailscaleIPs?: unknown };
  const ip = Array.isArray(TailscaleIPs) ? TailscaleIPs.find((a): a is string => typeof a === "string" && !a.includes(":")) : undefined;
  if (typeof ID !== "string" || ID === "" || typeof DNSName !== "string" || DNSName === "" || ip === undefined) return undefined;
  const host = DNSName.replace(/\.$/, "");
  return { id: ID, name: host.split(".")[0]!, host, ip };
}

/** `tailscale status --json`. A peer without a stable ID, a MagicDNS name or an IPv4 address cannot be configured, so it is left out. */
export function parseTailnet(statusJson: string): Tailnet {
  const status = JSON.parse(statusJson) as { Self?: unknown; Peer?: Record<string, unknown> | null };
  const self = device(status.Self);
  if (self === undefined) throw new Error("tailscale status --json gives this machine no ID, MagicDNS name and IPv4 address. Is tailscale up, with MagicDNS on?");
  const peers = Object.values(status.Peer ?? {}).flatMap((p) => device(p) ?? []);
  return { self, peers };
}

export interface Flags {
  node?: string;
  admit: readonly string[];
  addNode: readonly string[];
  peer: readonly string[];
  dotfiles?: string;
  nonInteractive: boolean;
  /** Names the control plane's GitHub token file as github.tokenFile, which the credentials step wrote. */
  githubWatch: boolean;
}

export function parseFlags(args: readonly string[]): { command: string | undefined; flags: Flags } {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      node: { type: "string" },
      admit: { type: "string", multiple: true, default: [] },
      "add-node": { type: "string", multiple: true, default: [] },
      peer: { type: "string", multiple: true, default: [] },
      dotfiles: { type: "string" },
      "non-interactive": { type: "boolean", default: false },
      "github-watch": { type: "boolean", default: false },
    },
  });
  const flags: Flags = {
    admit: values.admit, addNode: values["add-node"], peer: values.peer, nonInteractive: values["non-interactive"], githubWatch: values["github-watch"],
    ...values.node === undefined ? {} : { node: values.node },
    ...values.dotfiles === undefined ? {} : { dotfiles: values.dotfiles },
  };
  return { command: positionals[0], flags };
}

function resolve(tailnet: Tailnet, flag: string, name: string, errors: string[]): Device | undefined {
  const all = [tailnet.self, ...tailnet.peers];
  const wanted = name.toLowerCase();
  const matches = all.filter((d) => d.name === wanted || d.host === wanted || d.id === name);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) errors.push(`${flag} ${name}: tailscale knows no such device. It knows ${all.map((d) => d.name).sort().join(", ")}`);
  else errors.push(`${flag} ${name}: more than one device has that name: ${matches.map((d) => d.host).join(", ")}. Give the full MagicDNS name`);
  return undefined;
}

export interface Change { kind: "added" | "kept" | "replaced"; at: string; value: Json; existing?: Json }

const isObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: Json): v is readonly string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const isNodes = (v: Json): v is readonly JsonObject[] => Array.isArray(v) && v.every((e: Json) => isObject(e) && typeof e.tailnetNodeId === "string");

/**
 * Adds what `existing` lacks and never replaces what it has, so a person's edits survive every rerun. The paths in
 * `derived` are the exception: they follow from another file, such as a digest of deployer.json's token, so a stale
 * value would only lock this machine out.
 */
export function merge(existing: Json, generated: Json, changes: Change[], at = "", derived: ReadonlySet<string> = new Set()): Json {
  if (isObject(existing) && isObject(generated)) {
    const result: Record<string, Json> = { ...existing };
    for (const [key, value] of Object.entries(generated)) {
      const path = at === "" ? key : `${at}.${key}`;
      if (key in existing) result[key] = merge(existing[key]!, value, changes, path, derived);
      else {
        result[key] = value;
        changes.push({ kind: "added", at: path, value });
      }
    }
    return result;
  }
  if (isStrings(existing) && isStrings(generated)) {
    const added = generated.filter((s) => !existing.includes(s));
    for (const value of added) changes.push({ kind: "added", at, value });
    return [...existing, ...added];
  }
  if (isNodes(existing) && isNodes(generated)) {
    const added = generated.filter((g) => !existing.some((e) => e.tailnetNodeId === g.tailnetNodeId));
    for (const value of added) changes.push({ kind: "added", at, value });
    return [...existing, ...added];
  }
  if (isDeepStrictEqual(existing, generated)) return existing;
  if (derived.has(at)) {
    changes.push({ kind: "replaced", at, value: generated, existing });
    return generated;
  }
  changes.push({ kind: "kept", at, value: generated, existing });
  return existing;
}

export interface Existing { control?: Json; probe?: Json; deployer?: Json; gitKey: boolean }

export interface FileWrite {
  path: string;
  mode: number;
  value: Json;
  state: "new" | "updated" | "unchanged";
  changes: readonly Change[];
}

export type Setup = { ok: false; errors: readonly string[] } | { ok: true; files: readonly FileWrite[] };

const digestPattern = /^[0-9a-f]{64}$/;
const tsNet = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/;

export const tokenDigest = (token: string): string => createHash("sha256").update(token).digest("hex");

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function file(path: string, mode: number, existing: Json | undefined, generated: Json, derived: readonly string[] = []): FileWrite {
  const changes: Change[] = [];
  if (existing === undefined) return { path, mode, value: generated, state: "new", changes };
  const value = merge(existing, generated, changes, "", new Set(derived));
  return { path, mode, value, state: changes.some((c) => c.kind !== "kept") ? "updated" : "unchanged", changes };
}

/** Every config this machine needs, merged over what is on disk. `newToken` is used only when deployer.json has none. */
export function setup(tailnet: Tailnet, flags: Flags, existing: Existing, newToken: string): Setup {
  const errors: string[] = [];
  const { self } = tailnet;
  for (const [label, value] of [["control.json", existing.control], ["probe.json", existing.probe], ["deployer.json", existing.deployer]] as const) {
    if (value !== undefined && !isObject(value)) errors.push(`${label} on disk is not a JSON object. Fix or remove it`);
  }
  const deployerOnDisk = isObject(existing.deployer) ? existing.deployer : undefined;
  if (deployerOnDisk?.token !== undefined && typeof deployerOnDisk.token !== "string") errors.push("deployer.json on disk has a token that is not a string. Fix or remove it");

  const control = flags.node === undefined ? undefined : resolve(tailnet, "--node", flags.node, errors);
  if (control?.id === self.id) errors.push(`--node ${flags.node}: that is this machine. Leave out --node to install the control plane here`);
  if (flags.node !== undefined) {
    if (flags.admit.length > 0) errors.push("--admit is for the control machine. Run it there, without --node");
    if (flags.addNode.length > 0) errors.push("--add-node is for the control machine. Run it there, without --node");
    if (flags.dotfiles !== undefined) errors.push("--dotfiles is for the control machine. Run it there, without --node");
    if (flags.githubWatch) errors.push("--github-watch is for the control machine. Run it there, without --node");
  }

  const addNodes = flags.addNode.flatMap((raw) => {
    const at = raw.lastIndexOf("=");
    const [name, digest] = at === -1 ? [raw, ""] : [raw.slice(0, at), raw.slice(at + 1)];
    if (!digestPattern.test(digest)) errors.push(`--add-node ${raw}: give <device>=<digest>, the 64 lower-case hex characters that node's install printed`);
    const node = resolve(tailnet, "--add-node", name, errors);
    if (node?.id === self.id) errors.push(`--add-node ${name}: that is this machine, which is already a node`);
    return node === undefined ? [] : [{ node, digest }];
  });
  const peers = flags.peer.flatMap((name) => resolve(tailnet, "--peer", name, errors) ?? []);
  const admitted = flags.admit.flatMap((name) => resolve(tailnet, "--admit", name, errors) ?? []);

  const controlOnDisk = isObject(existing.control) ? existing.control : undefined;
  const nodeIds = new Set([self.id, ...addNodes.map((a) => a.node.id)]);
  if (Array.isArray(controlOnDisk?.nodes)) for (const n of controlOnDisk.nodes) if (isObject(n) && typeof n.tailnetNodeId === "string") nodeIds.add(n.tailnetNodeId);
  for (const d of admitted) {
    if (d.id === self.id) errors.push(`--admit ${d.name}: that is this machine. Admit the machine you run the nexus CLI on`);
    else if (nodeIds.has(d.id)) errors.push(`--admit ${d.name}: that is a node, and the control plane refuses a node as a deployer. Admit the machine you run the nexus CLI on`);
  }

  if (flags.node === undefined) {
    if (existing.control === undefined && flags.dotfiles === undefined) errors.push("--dotfiles <git url> is needed on the first control install: the dotfiles repository every new pylon pulls on boot");
    const probeOnDisk = isObject(existing.probe) ? existing.probe : undefined;
    const servedControl = isObject(probeOnDisk?.auth) ? probeOnDisk.auth.controlPlane : undefined;
    if (existing.control === undefined && typeof servedControl === "string" && servedControl !== self.id) {
      const known = tailnet.peers.find((p) => p.id === servedControl);
      errors.push(`this machine is already a node of the control plane ${known?.name ?? servedControl}. Pass --node ${known?.name ?? "<control device>"}`);
    }
  }
  if (flags.dotfiles?.startsWith("https://") && !URL.canParse(flags.dotfiles)) errors.push(`--dotfiles ${flags.dotfiles}: not a valid https:// URL`);

  if (errors.length > 0) return { ok: false, errors };

  const token = typeof deployerOnDisk?.token === "string" ? deployerOnDisk.token : newToken;
  const controlId = control?.id ?? self.id;
  const files: FileWrite[] = [];

  let controlUrl = `http://${control?.host}:${controlPort}/`;
  if (control === undefined) {
    const nodeEntry = (d: Device) => ({ name: d.name, tailnetHost: d.host, tailnetNodeId: d.id });
    const generated: JsonObject = {
      ...tsNet.test(self.host) ? { https: { hostname: self.host } } : {},
      db: "/var/lib/nexus-control/registry.db",
      listen: { host: self.ip, port: controlPort, hostnames: [self.name, self.host, self.ip] },
      self: { tailnetNodeId: self.id },
      nodes: [nodeEntry(self), ...addNodes.map((a) => nodeEntry(a.node))],
      // Only a new config names this machine: an existing one without it builds on the default node, as it did.
      ...existing.control === undefined ? { imageBuildNode: self.name } : {},
      callers: admitted.map((d) => d.id),
      deployers: admitted.map((d) => d.id),
      deployKeys: Object.fromEntries([[self.id, tokenDigest(token)], ...addNodes.map((a) => [a.node.id, a.digest])]),
      ...flags.dotfiles === undefined ? {} : { dotfiles: { repo: flags.dotfiles, ref: "main" } },
      ...flags.githubWatch ? { github: { tokenFile: stores.githubWatch.file } } : {},
      harness: {
        storage: "/var/lib/nexus-control/harness.sqlite",
        credentials: stores.harness.file,
        model: { provider: "openai", modelId: "gpt-6-astra" },
      },
    };
    const written = file(paths.control, 0o644, existing.control, generated, Object.keys(generated.deployKeys as JsonObject).map((id) => `deployKeys.${id}`));
    files.push(written);
    const listen = isObject(written.value) && isObject(written.value.listen) ? written.value.listen : {};
    controlUrl = `http://${urlHost(String(listen.host))}:${String(listen.port)}/`;
  }

  const existingBackend = isObject(existing.probe) ? existing.probe.backend : undefined;
  files.push(file(paths.probe, 0o644, existing.probe, {
    node: self.name,
    listen: { host: self.ip, port: 7480 },
    auth: { controlPlane: controlId, peers: [...control === undefined ? [] : [control.id], ...addNodes.map((a) => a.node.id), ...peers.map((d) => d.id)] },
    backend: {
      kind: "pylon-vm",
      stateRoot: "/var/lib/nexus/pylons",
      // A probe.json from before the artifact store names its store through `images`, which the probe refuses beside `artifacts`.
      ...isObject(existingBackend) && "images" in existingBackend ? {} : { artifacts: paths.artifacts },
      ...existing.gitKey ? { gitSsh: { privateKeyFile: paths.gitKey, knownHostsFile: paths.gitKnownHosts } } : {},
    },
    secretsFile: paths.secrets,
    previews: { gatewayPort: 7481 },
  }));

  files.push(file(paths.deployer, 0o600, existing.deployer, {
    controlUrl, controlNodeId: controlId, token, drainTimeoutMs: 300_000, healthTimeoutMs: 60_000,
  }, control === undefined ? ["controlUrl", "controlNodeId"] : []));
  return { ok: true, files };
}

function describe(change: Change): string {
  if (change.at === "token") return "added a new deployer token";
  if (change.kind === "added") return `added ${change.at} ${JSON.stringify(change.value)}`;
  if (change.kind === "replaced") return `replaced ${change.at} ${JSON.stringify(change.existing)} with ${JSON.stringify(change.value)}, which follows from this machine's deployer`;
  return `left ${change.at} alone: it is ${JSON.stringify(change.existing)}, and this run would write ${JSON.stringify(change.value)}. Edit the file to change it`;
}

export function report(files: readonly FileWrite[]): string {
  return files.flatMap((f) => [
    f.state === "new" ? `wrote ${f.path}` : f.state === "updated" ? `updated ${f.path}` : `${f.path} needs nothing new`,
    ...f.path === paths.deployer && f.state !== "new" ? ["  kept the existing deployer token"] : [],
    ...f.changes.map((c) => `  ${describe(c)}`),
  ]).join("\n");
}

/** What image builds need here: the Docker daemon and its buildx plugin, which images/pylon/build.sh calls. */
export type Docker =
  | { kind: "missing" | "ready" }
  /** `from` is where this Docker's packages came from: Docker's repository or the distribution's, which name buildx differently. */
  | { kind: "no-buildx"; manager: "apt" | "dnf" | "other"; from: "docker" | "distribution" };

const buildxPackage = { docker: "docker-buildx-plugin", distribution: "docker-buildx" } as const;
const packageInstall = { apt: "sudo apt-get install -y", dnf: "sudo dnf install -y" } as const;

export type Facts = {
  self: Device;
  /** The names in secrets.env, never their values. */
  secretNames: readonly string[];
  gitKey: boolean;
} & (
  | { role: "control"; signedIn: boolean; admitted: boolean; docker: Docker; dockerGroup: boolean; image: boolean }
  | { role: "node"; control: Device; digest: string }
);

/** Credentials come after the setup steps, and the first image after both, since building one needs the control plane running. */
const stages = ["setup", "credentials", "image"] as const;
export interface Item { stage: (typeof stages)[number]; say: string; run: readonly string[] }

/** What the person still has to do on this machine and elsewhere, in the order to do it. */
export function left(facts: Facts): Item[] {
  const items: Item[] = [];
  const { self } = facts;
  const control = facts.role === "control" ? self : facts.control;
  const rerun = facts.role === "control" ? "sudo deploy/install.sh" : `sudo deploy/install.sh --node ${control.name}`;
  if (facts.role === "control" && !facts.admitted) items.push({
    stage: "setup",
    say: "Admit your Mac, so its nexus CLI may call the control plane.",
    run: ["sudo deploy/install.sh --admit <your Mac's tailnet name>"],
  });
  if (facts.role === "node") items.push({
    stage: "setup",
    say: `Register this node: run the first command on ${control.name}, the second on each other probe-only node, and the third here, naming each of those nodes, since probes fetch images from each other.`,
    run: [
      `sudo deploy/install.sh --add-node ${self.name}=${facts.digest}`,
      `sudo deploy/install.sh --node ${control.name} --peer ${self.name}`,
      `sudo deploy/install.sh --node ${control.name} --peer <other node> --peer <another node>`,
    ],
  });
  items.push({
    stage: "setup",
    say: `Set up the nexus CLI on your Mac, in a nexus checkout with Node 26, before the steps below that run nexus there. When the Mac reaches the tailnet through a SOCKS proxy rather than the Tailscale app, add --socks localhost:1055 to nexus connect.`,
    run: ["deploy/mac/install", `nexus connect ${control.host}`],
  });
  const missing = [
    ...facts.role === "control" && !facts.signedIn ? ["the harness's login, with ChatGPT or an OpenAI API key, which the control plane needs before it starts"] : [],
    ...!claudeNames.some((name) => facts.secretNames.includes(name)) ? ["a Claude token, which `claude setup-token` prints wherever Claude Code runs with a browser, or an Anthropic API key"] : [],
    ...!facts.secretNames.includes("GH_TOKEN") ? ["a GitHub token, fine-grained for all repositories with Administration and Contents read and write"] : [],
    ...!facts.gitKey ? ["a git SSH key, which the installer makes here"] : [],
  ];
  if (missing.length > 0) items.push({
    stage: "credentials",
    say: `Rerun the installer in a terminal, which asks for what the agents still lack: ${missing.join("; ")}.`,
    run: [rerun],
  });
  if (facts.role === "control" && facts.docker.kind === "missing") items.push({
    stage: "setup",
    say: "Image builds run here and need Docker with its buildx plugin. Docker's install script installs both, and systemd starts the daemon.",
    run: ["curl -fsSL https://get.docker.com | sudo sh", "sudo systemctl enable --now docker"],
  });
  if (facts.role === "control" && facts.docker.kind === "no-buildx") {
    const { manager, from } = facts.docker;
    const source = from === "docker" ? "Docker's repository" : "the distribution";
    items.push(manager === "other" ? {
      stage: "setup",
    say: "Docker here lacks the buildx plugin, which image builds use. Install it as https://docs.docker.com/go/buildx/ describes.",
      run: [],
    } : {
      stage: "setup",
    say: `Docker here lacks the buildx plugin, which image builds use. This Docker came from ${source}, whose buildx package is ${buildxPackage[from]}.`,
      run: [`${packageInstall[manager]} ${buildxPackage[from]}`],
    });
  }
  if (facts.role === "control" && !facts.dockerGroup) items.push({
    stage: "setup",
    say: "Image builds run here and need Docker. Membership of the docker group is root-equivalent, so adding nexus to it is your call.",
    run: ["sudo usermod --append --groups docker nexus && sudo systemctl restart nexus-probe"],
  });
  if (facts.role === "control" && !facts.image) items.push({
    stage: "image",
    say: "Build the first pylon image from your Mac, then roll out the image ID it printed.",
    run: ["nexus image build --wait", "nexus image rollout <image ID it printed> --wait"],
  });
  return stages.flatMap((stage) => items.filter((item) => item.stage === stage));
}

const headings = {
  setup: "What is left:",
  credentials: "Next, give the agents their credentials, on this machine:",
  image: "Then, with the control plane running:",
} as const;

export function formatLeft(items: readonly Item[]): string {
  return items.flatMap((item, i) => [
    ...item.stage !== items[i - 1]?.stage ? [...i === 0 ? [] : [""], headings[item.stage]] : [],
    `${i + 1}. ${item.say}`,
    ...item.run.map((command) => `     ${command}`),
  ]).join("\n");
}

async function readJsonFile(path: string, errors: string[]): Promise<Json | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as Json;
  } catch (err) {
    errors.push(`${path} is not valid JSON: ${(err as Error).message}`);
    return undefined;
  }
}

const exists = (path: string) => access(path).then(() => true, () => false);

async function tailnet(): Promise<Tailnet> {
  const { stdout } = await exec("tailscale", ["status", "--json"], { maxBuffer: 16 * 1024 * 1024 });
  return parseTailnet(stdout);
}

async function writeAtomic(path: string, value: Json, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function write(flags: Flags): Promise<number> {
  const errors: string[] = [];
  const existing: Existing = {
    gitKey: await exists(paths.gitKey),
    ...await readJsonFile(paths.control, errors).then((control) => control === undefined ? {} : { control }),
    ...await readJsonFile(paths.probe, errors).then((probe) => probe === undefined ? {} : { probe }),
    ...await readJsonFile(paths.deployer, errors).then((deployer) => deployer === undefined ? {} : { deployer }),
  };
  const result = errors.length > 0 ? { ok: false as const, errors } : setup(await tailnet(), flags, existing, randomBytes(32).toString("hex"));
  if (!result.ok) {
    for (const error of result.errors) console.error(`install: ${error}`);
    return 1;
  }
  for (const f of result.files) if (f.state !== "unchanged") await writeAtomic(f.path, f.value, f.mode);
  console.log(report(result.files));
  return 0;
}

/** The package manager, and whether Docker's own docker-ce-cli package is installed or the distribution's Docker is. */
async function dockerSource(): Promise<Docker> {
  const env = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
  const succeeds = (program: string, args: string[]) => exec(program, args, { env }).then(() => true, () => false);
  const from = (installed: boolean) => installed ? "docker" as const : "distribution" as const;
  if (await succeeds("sh", ["-c", "command -v apt-get"])) return { kind: "no-buildx", manager: "apt", from: from(await exec("dpkg-query", ["-W", "-f=${db:Status-Status}", "docker-ce-cli"], { env }).then(({ stdout }) => stdout === "installed", () => false)) };
  if (await succeeds("sh", ["-c", "command -v dnf"])) return { kind: "no-buildx", manager: "dnf", from: from(await succeeds("rpm", ["-q", "docker-ce-cli"])) };
  return { kind: "no-buildx", manager: "other", from: "distribution" };
}

async function gather(flags: Flags): Promise<Facts> {
  const net = await tailnet();
  const at = await locations(system);
  const names = await readFile(at.secrets, "utf8").then(secretNames, () => []);
  const common = { self: net.self, secretNames: names, gitKey: await exists(at.gitKey) };
  const deployer = JSON.parse(await readFile(paths.deployer, "utf8")) as { token: string };
  if (flags.node !== undefined) {
    const errors: string[] = [];
    const control = resolve(net, "--node", flags.node, errors);
    if (control === undefined) throw new Error(errors.join("; "));
    return { ...common, role: "node", control, digest: tokenDigest(deployer.token) };
  }
  const config = JSON.parse(await readFile(paths.control, "utf8")) as { callers: string[]; harness: { credentials: string } };
  const credentials = await readFile(config.harness.credentials, "utf8").then(
    (text) => Object.keys((JSON.parse(text) as { credentials?: object }).credentials ?? {}).length > 0,
    () => false,
  );
  const groups = await exec("id", ["-nG", "nexus"]).then(({ stdout }) => stdout.trim().split(/\s+/), (): string[] => []);
  const succeeds = (args: string[]) => exec("docker", args, { env: { PATH: "/usr/local/bin:/usr/bin" } }).then(() => true, () => false);
  const docker: Docker = !await succeeds(["--version"]) ? { kind: "missing" } : await succeeds(["buildx", "version"]) ? { kind: "ready" } : await dockerSource();
  const image = await readdir(paths.artifacts).then((entries) => entries.some((e) => e.startsWith("img-")), () => false);
  return {
    ...common, role: "control", signedIn: credentials,
    admitted: config.callers.length > 0, docker, dockerGroup: groups.includes("docker"), image,
  };
}

async function main(args: readonly string[]): Promise<number> {
  const { command, flags } = parseFlags(args);
  if (command === "write") return await write(flags);
  if (command === "credentials") {
    if (!flags.nonInteractive && !process.stdin.isTTY) console.error("No terminal, so the credentials come from NEXUS_* variables, as deploy/README.md describes, and the rest are skipped.");
    const answers = flags.nonInteractive || !process.stdin.isTTY ? scripted(process.env) : terminal();
    const next = new Set<FollowUp>();
    try {
      await provision(flags.node === undefined ? "control" : "node", system, answers, (line) => console.error(line), next);
    } finally {
      for (const step of next) console.log(step);
    }
    return 0;
  }
  if (command === "left") {
    console.log(formatLeft(left(await gather(flags))));
    return 0;
  }
  console.error("usage: node src/deploy/setup.ts write|credentials|left [--node <control device>] [--admit <device>]... [--add-node <device>=<digest>]... [--peer <device>]... [--dotfiles <git url>] [--non-interactive] [--github-watch]");
  return 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => {
    console.error(`install: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
