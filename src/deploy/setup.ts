/**
 * The installer once `deploy/install.sh` has checked the prerequisites: `node src/deploy/setup.ts install --package-manager
 * apt|dnf|other [--node <control device>] [--join <token>] [--admit <device>]... [--add-node <device>=<digest>]...
 * [--peer <device>]... [--dotfiles <git url>] [--non-interactive] [--upgrade]` writes /etc/nexus/{control,control-plane,probe,deployer}.json,
 * runs the role installers, which keep the release a role runs unless --upgrade, joins a node to its control
 * plane with a join token, gives the agents their credentials (src/deploy/credentials.ts) and says what is left for the person. `write`, with the same flags and `--github-watch`, writes
 * the configs alone, which `install` runs under the deployer's lock.
 * `node src/deploy/setup.ts signed-in <control.json>` exits 0 when the harness that config names is signed in.
 * `node src/deploy/setup.ts registry <control.json>` exits 1 when that config's registry is newer than this checkout's migrations.
 * It runs as root from a checkout before `npm ci`, so it imports only Node's builtins and modules that do too.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { promisify, isDeepStrictEqual, parseArgs } from "node:util";
import { claudeNames, harnessSignedIn, locations, provision, rotatable, rotate, scripted, stores, system, terminal, heldNames, type FollowUp, type Rotatable } from "./credentials.ts";
import { parseWorkerConfig, readControlPlane, type WorkerConfig } from "./control-plane.ts";
import { parseSecretsFile } from "../node-base/secrets-env.ts";
import { DeployHttpError, jsonRequest, urlHost } from "./http.ts";
import { digestPattern, tokenDigest, tsNet } from "../protocol/deploy.ts";
import { readJson, saveJson } from "../node-base/json-file.ts";
import { controlFields, listenAddress } from "../node-base/node-config.ts";
import { isImageId } from "../ids.ts";
import { shellQuote } from "../shell.ts";
import { tailscaleCli, tailscaleStatus, type TailnetDevice, type TailscaleStatus } from "../tailscale.ts";
import { localApiWhois } from "../node-base/tailscaled.ts";
import { backupStatusFile, configFiles, deployerFiles, ports, prefix, readReleaseCommit, rootPath, servicePath, stateDirs, unitNames, users } from "../node-base/node-layout.ts";
import { awaitHealthy } from "./health.ts";
import { schemaStep } from "./plan.ts";
import { nodeRegistry } from "./worker.ts";
import type { Whois } from "../protocol/http.ts";
import { defaultHarnessModel } from "../protocol/models.ts";

const exec = promisify(execFile);

export const paths = {
  control: configFiles.control,
  controlPlane: configFiles.controlPlane,
  probe: configFiles.probe,
  deployer: configFiles.deployer,
  secrets: stores.claude.file,
  gitKey: stores.gitKey.file,
  gitKnownHosts: configFiles.gitKnownHosts,
  artifacts: `${stateDirs.probe}/artifacts`,
} as const;

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

export interface Device { id: string; name: string; host: string; ip: string }
export interface Tailnet { self: Device; peers: readonly Device[] }

/** The devices setup can name. One without a stable ID, a MagicDNS name or an IPv4 address cannot be configured, so it is left out. */
export function tailnetDevices(status: TailscaleStatus): Tailnet {
  const self = device(status.self);
  if (self === undefined) throw new Error("tailscale status --json gives this machine no ID, MagicDNS name and IPv4 address. Is tailscale up, with MagicDNS on?");
  return { self, peers: status.peers.flatMap((p) => device(p) ?? []) };
}

function device(d: TailnetDevice | null): Device | undefined {
  if (d === null || d.id === null || d.host === null || d.ipv4 === null) return undefined;
  return { id: d.id, name: d.host.split(".")[0]!, host: d.host, ip: d.ipv4 };
}

export interface Flags {
  node?: string;
  /** A join token minted on the control plane's machine, which registers this node there. */
  join?: string;
  admit: readonly string[];
  addNode: readonly string[];
  peer: readonly string[];
  dotfiles?: string;
  nonInteractive: boolean;
  /** Names the control plane's GitHub token file as github.tokenFile, which the credentials step wrote. */
  githubWatch: boolean;
  /** Installs the checkout's release over the one a role runs. */
  upgrade: boolean;
  /** install.sh's, which it needs before Node is installed. */
  packageManager?: PackageManager;
}

export type PackageManager = "apt" | "dnf" | "other";
const packageManagers: readonly string[] = ["apt", "dnf", "other"] satisfies PackageManager[];

export function parseFlags(args: readonly string[]): { command: string | undefined; operands: readonly string[]; flags: Flags } {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      node: { type: "string" },
      join: { type: "string" },
      admit: { type: "string", multiple: true, default: [] },
      "add-node": { type: "string", multiple: true, default: [] },
      peer: { type: "string", multiple: true, default: [] },
      dotfiles: { type: "string" },
      "non-interactive": { type: "boolean", default: false },
      "github-watch": { type: "boolean", default: false },
      upgrade: { type: "boolean", default: false },
      "package-manager": { type: "string" },
    },
  });
  const manager = values["package-manager"];
  if (manager !== undefined && !packageManagers.includes(manager)) throw new Error(`--package-manager ${manager}: give ${packageManagers.join(", ")}`);
  const flags: Flags = {
    admit: values.admit, addNode: values["add-node"], peer: values.peer, nonInteractive: values["non-interactive"], githubWatch: values["github-watch"], upgrade: values.upgrade,
    ...values.node === undefined ? {} : { node: values.node },
    ...values.join === undefined ? {} : { join: values.join },
    ...values.dotfiles === undefined ? {} : { dotfiles: values.dotfiles },
    ...manager === undefined ? {} : { packageManager: manager as PackageManager },
  };
  return { command: positionals[0], operands: positionals.slice(1), flags };
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

export interface Existing { control?: Json; controlPlane?: Json; probe?: Json; deployer?: Json; gitKey: boolean }

export interface FileWrite {
  path: string;
  mode: number;
  value: Json;
  state: "new" | "updated" | "unchanged";
  changes: readonly Change[];
  /** The paths whose values the report never prints, each with what to call it. */
  secrets: Readonly<Record<string, string>>;
}

export type Setup = { ok: false; errors: readonly string[] } | { ok: true; files: readonly FileWrite[] };

function file(path: string, mode: number, existing: Json | undefined, generated: Json, derived: readonly string[] = [], secrets: Readonly<Record<string, string>> = {}): FileWrite {
  const changes: Change[] = [];
  if (existing === undefined) return { path, mode, value: generated, state: "new", changes, secrets };
  const value = merge(existing, generated, changes, "", new Set(derived));
  return { path, mode, value, state: changes.some((c) => c.kind !== "kept") ? "updated" : "unchanged", changes, secrets };
}

/** The branch of --dotfiles that pylons pull. */
const dotfilesRef = "main";

/** What `git ls-remote` on this machine says of a dotfiles repository, before the installer names it in control.json. */
export type DotfilesCheck =
  | { kind: "reachable" }
  | { kind: "refused" | "unchecked"; reason: string };

/**
 * Whether git here reaches `ref` of `url` as a pylon would: an HTTPS URL without credentials, and any other with the
 * node's git SSH key and known hosts. The credentials step makes that key after the configs are written, so a first
 * install cannot check an SSH URL yet. No git config of this machine applies, neither root's nor that of a
 * repository around the installer's working directory, so no credential helper or URL rewrite passes a repository
 * that pylons cannot fetch.
 */
export async function checkDotfiles(url: string, ref: string, ssh: { key: string; knownHosts: string } | null): Promise<DotfilesCheck> {
  const https = url.startsWith("https://");
  if (!https && ssh === null) return { kind: "unchecked", reason: "pylons reach an SSH URL with this machine's git SSH key, which the credentials step makes. Once its public key is on GitHub, rerun the installer with the same --dotfiles to check the URL" };
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && name !== "SSH_ASKPASS"));
  const env = {
    ...inherited, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: "/",
    ...https || ssh === null ? {} : { GIT_SSH_COMMAND: `ssh -i ${shellQuote(ssh.key)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(ssh.knownHosts)}` },
  };
  try {
    await exec("git", ["-c", "credential.helper=", "ls-remote", "--exit-code", "--", url, `refs/heads/${ref}`], { cwd: "/", env, timeout: 60_000 });
    return { kind: "reachable" };
  } catch (err) {
    const failed = err as { code?: unknown; killed?: boolean; stderr?: string };
    if (failed.code === 2) return { kind: "refused", reason: `the repository has no branch ${ref}, which pylons pull` };
    if (failed.killed === true) return { kind: "refused", reason: "git ls-remote did not answer within 60 s" };
    const said = (failed.stderr ?? "").trim().split("\n").filter((line) => line !== "").join(" ");
    const hint = https ? ". When the repository is private, give its SSH URL, which pylons reach with the node's git SSH key" : "";
    return { kind: "refused", reason: `git ls-remote failed${said === "" ? "" : `: ${said}`}${hint}` };
  }
}

/** Every config this machine needs, merged over what is on disk. `newToken` is used only when deployer.json has none. */
export function setup(tailnet: Tailnet, flags: Flags, existing: Existing, newToken: string): Setup {
  const errors: string[] = [];
  const { self } = tailnet;
  for (const [label, value] of [["control.json", existing.control], ["control-plane.json", existing.controlPlane], ["probe.json", existing.probe], ["deployer.json", existing.deployer]] as const) {
    if (value !== undefined && !isObject(value)) errors.push(`${label} on disk is not a JSON object. Fix or remove it`);
  }
  const deployerOnDisk = isObject(existing.deployer) ? existing.deployer : undefined;
  if (deployerOnDisk?.token !== undefined && typeof deployerOnDisk.token !== "string") errors.push("deployer.json on disk has a token that is not a string. Fix or remove it");

  const control = flags.node === undefined ? undefined : resolve(tailnet, "--node", flags.node, errors);
  if (control?.id === self.id) errors.push(`--node ${flags.node}: that is this machine. Leave out --node to install the control plane here`);
  if (flags.join !== undefined && flags.node === undefined) errors.push("--join needs --node <the control plane's tailnet name>, as --join-token printed it");
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
    const servedControl = isObject(existing.controlPlane) ? existing.controlPlane.tailnetNodeId : undefined;
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

  let controlUrl = `http://${control?.host}:${ports.control}/`;
  if (control === undefined) {
    const nodeEntry = (d: Device) => ({ name: d.name, tailnetHost: d.host, tailnetNodeId: d.id });
    const generated: JsonObject = {
      ...tsNet.test(self.host) ? { https: { hostname: self.host } } : {},
      db: `${stateDirs.control}/registry.db`,
      listen: { host: self.ip, port: ports.control, hostnames: [self.name, self.host, self.ip] },
      self: { tailnetNodeId: self.id },
      nodes: [nodeEntry(self), ...addNodes.map((a) => nodeEntry(a.node))],
      // Only a new config names this machine: an existing one without it keeps building on the schema's default node.
      ...existing.control === undefined ? { imageBuildNode: self.name } : {},
      callers: admitted.map((d) => d.id),
      deployers: admitted.map((d) => d.id),
      deployKeys: Object.fromEntries([[self.id, tokenDigest(token)], ...addNodes.map((a) => [a.node.id, a.digest])]),
      ...flags.dotfiles === undefined ? {} : { dotfiles: { repo: flags.dotfiles, ref: dotfilesRef } },
      ...flags.githubWatch ? { github: { tokenFile: stores.githubWatch.file } } : {},
      harness: {
        storage: `${stateDirs.control}/harness.sqlite`,
        credentials: stores.harness.file,
        model: defaultHarnessModel,
      },
    };
    const written = file(paths.control, 0o644, existing.control, generated, Object.keys(generated.deployKeys as JsonObject).map((id) => `deployKeys.${id}`));
    files.push(written);
    const listen = isObject(written.value) && isObject(written.value.listen) ? written.value.listen : {};
    controlUrl = `http://${urlHost(String(listen.host))}:${String(listen.port)}/`;
  }

  files.push(file(paths.controlPlane, 0o644, existing.controlPlane, { tailnetNodeId: controlId, url: controlUrl }, control === undefined ? ["tailnetNodeId", "url"] : []));

  files.push(file(paths.probe, 0o644, existing.probe, {
    node: self.name,
    listen: { host: self.ip, port: ports.probe },
    auth: { peers: [...control === undefined ? [] : [control.id], ...addNodes.map((a) => a.node.id), ...peers.map((d) => d.id)] },
    backend: {
      kind: "pylon-vm",
      stateRoot: `${stateDirs.probe}/pylons`,
      artifacts: paths.artifacts,
      ...existing.gitKey ? { gitSsh: { privateKeyFile: paths.gitKey, knownHostsFile: paths.gitKnownHosts } } : {},
    },
    secretsFile: paths.secrets,
    previews: { gatewayPort: ports.gateway },
  }));

  files.push(file(paths.deployer, 0o600, existing.deployer, { token, drainTimeoutMs: 300_000, healthTimeoutMs: 60_000 }, [], { token: "deployer token" }));
  return { ok: true, files };
}

function describe(change: Change, secrets: FileWrite["secrets"]): string {
  const secret = secrets[change.at];
  if (secret !== undefined) return `added a new ${secret}`;
  if (change.kind === "added") return `added ${change.at} ${JSON.stringify(change.value)}`;
  if (change.kind === "replaced") return `replaced ${change.at} ${JSON.stringify(change.existing)} with ${JSON.stringify(change.value)}, which follows from this machine's deployer`;
  return `left ${change.at} alone: it is ${JSON.stringify(change.existing)}, and this run would write ${JSON.stringify(change.value)}. Edit the file to change it`;
}

export function report(files: readonly FileWrite[]): string {
  return files.flatMap((f) => [
    f.state === "new" ? `wrote ${f.path}` : f.state === "updated" ? `updated ${f.path}` : `${f.path} needs nothing new`,
    ...f.state === "new" ? [] : Object.entries(f.secrets).flatMap(([at, secret]) => f.changes.some((c) => c.at === at) ? [] : [`  kept the existing ${secret}`]),
    ...f.changes.map((c) => `  ${describe(c, f.secrets)}`),
  ]).join("\n");
}

/** What image builds need here: the Docker daemon and its buildx plugin, which images/pylon/build.sh calls. */
export type Docker =
  | { kind: "missing" | "ready" }
  /** `from` is where this Docker's packages came from: Docker's repository or the distribution's, which name buildx differently. */
  | { kind: "no-buildx"; manager: PackageManager; from: "docker" | "distribution" };

const buildxPackage = { docker: "docker-buildx-plugin", distribution: "docker-buildx" } as const;
const packageInstall = { apt: "sudo apt-get install -y", dnf: "sudo dnf install -y" } as const;

export type Facts = {
  self: Device;
  /** The names in secrets.env, never their values. */
  secretNames: readonly string[];
  gitKey: boolean;
} & (
  | { role: "control"; signedIn: boolean; admitted: boolean; docker: Docker; dockerGroup: boolean; image: boolean }
  /** `joined` when this run joined the control plane with a token. */
  | { role: "node"; control: Device; joined: boolean }
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
  if (facts.role === "node" && !facts.joined) items.push({
    stage: "setup",
    say: `Unless this node is registered already, mint a join token on ${control.name} with the first command, then run the command it prints here. It is like the second. The control plane follows this node from then on, and tells every other node about it.`,
    run: ["sudo deploy/install.sh --join-token", `sudo deploy/install.sh --join <token> --node ${control.name}`],
  });
  // The first image is built from the Mac with `nexus image build`, so one in the store shows the CLI reached this
  // control plane. A node's list leaves the CLI to the control plane's, since nexus connect names the control plane.
  if (facts.role === "control" && !facts.image) items.push({
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
    say: `Image builds run here and need Docker. Membership of the docker group is root-equivalent, so adding ${users.probe} to it is your call.`,
    run: [`sudo usermod --append --groups docker ${users.probe} && sudo systemctl restart nexus-probe`],
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
  if (items.length === 0) return "Nothing is left to do.";
  return items.flatMap((item, i) => [
    ...item.stage !== items[i - 1]?.stage ? [...i === 0 ? [] : [""], headings[item.stage]] : [],
    `${i + 1}. ${item.say}`,
    ...item.run.map((command) => `     ${command}`),
  ]).join("\n");
}

async function readJsonFile(path: string, errors: string[]): Promise<Json | undefined> {
  try {
    return await readJson(path) as Json | undefined;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    errors.push(`${path} is not valid JSON: ${err.message}`);
    return undefined;
  }
}

async function tailnet(): Promise<Tailnet> {
  return tailnetDevices(await tailscaleStatus(tailscaleCli()));
}

async function write(flags: Flags): Promise<number> {
  const errors: string[] = [];
  const existing: Existing = {
    gitKey: await system.exists(paths.gitKey),
    ...await readJsonFile(paths.control, errors).then((control) => control === undefined ? {} : { control }),
    ...await readJsonFile(paths.controlPlane, errors).then((controlPlane) => controlPlane === undefined ? {} : { controlPlane }),
    ...await readJsonFile(paths.probe, errors).then((probe) => probe === undefined ? {} : { probe }),
    ...await readJsonFile(paths.deployer, errors).then((deployer) => deployer === undefined ? {} : { deployer }),
  };
  const result = errors.length > 0 ? { ok: false as const, errors } : setup(await tailnet(), flags, existing, randomBytes(32).toString("hex"));
  if (!result.ok) {
    for (const error of result.errors) console.error(`install: ${error}`);
    return 1;
  }
  const step = dotfilesStep(flags.dotfiles, result.files);
  if (step.kind === "kept") console.log(`--dotfiles ${flags.dotfiles}: control.json keeps ${step.held}, so the URL is not checked. Edit the file to change it`);
  if (step.kind === "check") {
    const check = await checkDotfiles(step.url, step.ref, step.ssh);
    if (check.kind === "refused") {
      console.error(`install: --dotfiles ${step.url}: ${check.reason}`);
      return 1;
    }
    if (check.kind === "unchecked") console.log(`--dotfiles ${step.url} is not checked yet: ${check.reason}`);
  }
  for (const f of result.files) if (f.state !== "unchanged") await saveJson(f.path, f.value, { mode: f.mode, mkdir: true });
  console.log(report(result.files));
  return 0;
}

/**
 * What a write does about --dotfiles: check the URL and branch control.json holds, which a rerun keeps as they are,
 * with the probe's git SSH key, or say control.json keeps another URL.
 */
export type DotfilesStep =
  | { kind: "none" }
  | { kind: "check"; url: string; ref: string; ssh: { key: string; knownHosts: string } | null }
  | { kind: "kept"; held: string };

export function dotfilesStep(flag: string | undefined, files: readonly FileWrite[]): DotfilesStep {
  if (flag === undefined) return { kind: "none" };
  const control = files.find((f) => f.path === paths.control)?.value;
  const dotfiles = isObject(control) ? control.dotfiles : undefined;
  if (!isObject(dotfiles) || typeof dotfiles.repo !== "string" || typeof dotfiles.ref !== "string") return { kind: "none" };
  return dotfiles.repo === flag ? { kind: "check", url: flag, ref: dotfiles.ref, ssh: probeGitSsh(files) } : { kind: "kept", held: dotfiles.repo };
}

/** The git SSH key and known hosts the probe.json being written names, which the probe hands its pylons. */
function probeGitSsh(files: readonly FileWrite[]): { key: string; knownHosts: string } | null {
  const probe = files.find((f) => f.path === paths.probe)?.value;
  const backend = isObject(probe) ? probe.backend : undefined;
  const gitSsh = isObject(backend) ? backend.gitSsh : undefined;
  if (!isObject(gitSsh) || typeof gitSsh.privateKeyFile !== "string" || typeof gitSsh.knownHostsFile !== "string") return null;
  return { key: gitSsh.privateKeyFile, knownHosts: gitSsh.knownHostsFile };
}

/** Whether Docker's own docker-ce-cli package is installed or the distribution's Docker is. */
async function dockerSource(manager: PackageManager): Promise<Docker> {
  const env = { PATH: rootPath };
  const installed = manager === "apt" ? await exec("dpkg-query", ["-W", "-f=${db:Status-Status}", "docker-ce-cli"], { env }).then(({ stdout }) => stdout === "installed", () => false)
    : manager === "dnf" ? await exec("rpm", ["-q", "docker-ce-cli"], { env }).then(() => true, () => false)
    : false;
  return { kind: "no-buildx", manager, from: installed ? "docker" : "distribution" };
}

/** A crashed fill leaves `<id>.partial` beside the images (src/image/artifacts.ts), which is not an image. */
export const holdsImage = (store: string) => readdir(store).then((entries) => entries.some(isImageId), () => false);

async function gather(flags: Flags, manager: PackageManager): Promise<Facts> {
  const net = await tailnet();
  const at = await locations(system);
  const secrets = parseSecretsFile(at.secrets, await system.read(at.secrets).catch(() => undefined) ?? "", heldNames);
  const common = { self: net.self, secretNames: secrets.names(), gitKey: await system.exists(at.gitKey) };
  if (flags.node !== undefined) {
    const errors: string[] = [];
    const control = resolve(net, "--node", flags.node, errors);
    if (control === undefined) throw new Error(errors.join("; "));
    return { ...common, role: "node", control, joined: flags.join !== undefined };
  }
  const { callers } = controlFields(await readJson(paths.control), paths.control);
  if (callers === undefined) throw new Error(`${paths.control} has no callers`);
  const credentials = await system.read(at.harness).catch(() => undefined);
  const groups = await exec("id", ["-nG", users.probe]).then(({ stdout }) => stdout.trim().split(/\s+/), (): string[] => []);
  const succeeds = (args: string[]) => exec("docker", args, { env: { PATH: servicePath } }).then(() => true, () => false);
  const docker: Docker = !await succeeds(["--version"]) ? { kind: "missing" } : await succeeds(["buildx", "version"]) ? { kind: "ready" } : await dockerSource(manager);
  const image = await holdsImage(paths.artifacts);
  return {
    ...common, role: "control", signedIn: credentials !== undefined && harnessSignedIn(credentials),
    admitted: callers.length > 0, docker, dockerGroup: groups.includes("docker"), image,
  };
}

/**
 * Sends the join token and this node's deploy key digest to the control plane control-plane.json names, once tailscaled says
 * the endpoint is that tailnet node. The control plane records this node as its own whois of the caller says.
 */
export async function joinControlPlane(deployer: Pick<WorkerConfig, "controlUrl" | "controlNodeId" | "token">, token: string, whois: Whois): Promise<string> {
  try {
    const joined = await jsonRequest(new URL("v1/join", deployer.controlUrl), "POST", { token, deployKey: tokenDigest(deployer.token) }, null, { id: deployer.controlNodeId, whois }) as { node: string };
    return joined.node;
  } catch (err) {
    throw new Error(`the control plane at ${deployer.controlUrl} did not take the join: ${refusal(err) ?? (err as Error).message}`);
  }
}

/** The control plane's own words when it refused with `{ "error": string }`. */
function refusal(err: unknown): string | undefined {
  if (!(err instanceof DeployHttpError)) return undefined;
  try {
    const { error } = JSON.parse(err.body) as { error?: unknown };
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the harness the control.json at `path` names is signed in. A missing credentials file is not. */
async function signedIn(path: string): Promise<boolean> {
  const { harnessCredentials } = controlFields(await readJson(path), path);
  if (harnessCredentials === undefined) throw new Error(`${path} has no harness.credentials`);
  const text = await system.read(harnessCredentials);
  try {
    return text !== undefined && harnessSignedIn(text);
  } catch (err) {
    throw new Error(`${harnessCredentials} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Why this checkout's control plane would refuse the registry the control.json at `path` names, or null when it would open it. */
async function registryRefusal(path: string): Promise<string | null> {
  const registry = nodeRegistry({ config: path, home: stateDirs.control, prefix, status: backupStatusFile });
  const versions = { registry: await registry.version(), release: await registry.known(repo) };
  if (schemaStep(versions) !== "refuses") return null;
  return `the registry is at schema version ${versions.registry}, newer than the ${versions.release ?? 0} migrations this checkout applies, so its control plane would refuse to start. Install from a newer checkout, or deploy one with nexus deploy`;
}

/** The steps `install` takes that act on the machine, so the tests can record them. */
export interface InstallSteps {
  /** Runs a program on this terminal and resolves its exit code. */
  run(program: string, args: readonly string[]): Promise<number>;
  join(token: string): Promise<void>;
  credentials(next: Set<FollowUp>): Promise<void>;
  left(): Promise<void>;
}

class Exit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exited with ${code}`);
    this.code = code;
  }
}

const repo = resolvePath(import.meta.dirname, "../..");

/**
 * `args` without --dotfiles, for the config write after the credentials step. That write would check an SSH URL with the
 * key the step just made, before the person has added it to GitHub, and control.json keeps the URL without the flag.
 */
export function withoutDotfiles(args: readonly string[]): string[] {
  const end = args.indexOf("--");
  const flags = end === -1 ? args : args.slice(0, end);
  const kept = flags.filter((arg, i) => arg !== "--dotfiles" && flags[i - 1] !== "--dotfiles" && !arg.startsWith("--dotfiles="));
  return end === -1 ? kept : [...kept, ...args.slice(end)];
}

/** `args` are install's own, which each config write gets again, less --dotfiles after the first. */
export async function install(flags: Flags, args: readonly string[], steps: InstallSteps): Promise<number> {
  const run = async (program: string, ...rest: string[]) => {
    const code = await steps.run(program, rest);
    if (code !== 0) throw new Exit(code);
  };
  const installer = (role: string, ...rest: string[]) => run("bash", join(repo, `deploy/install-${role}.sh`), ...flags.upgrade && role !== "deployer" ? ["--upgrade"] : [], ...rest);
  // The deployer's lock, which every installer and the deployer's worker take, keeps two runs from merging at once.
  // A write holds it alone, because each installer takes it itself.
  const lock = join(prefix, deployerFiles.lock);
  const write = async (more: readonly string[], person: readonly string[] = args) => {
    await run("install", "-d", "-o", "root", "-g", "root", "-m", "0700", dirname(lock));
    // Before the person's arguments, which may end with `--`.
    await run("flock", "-x", lock, process.execPath, join(repo, "src/deploy/setup.ts"), "write", ...more, ...person);
  };
  if (flags.githubWatch) throw new Error("--github-watch is for setup.ts write. install names the GitHub token file once the credentials step has written it");
  if (args.filter((arg) => arg.startsWith("--package-manager")).length > 1) throw new Error("--package-manager is install.sh's, which names the one it found");
  try {
    await write([]);
    if (flags.node === undefined) await installer("control");
    await installer("probe");
    await installer("deployer", ...flags.node === undefined ? ["control", "probe"] : ["probe"]);
    // Before the credentials' prompts, so a refused token stops the run before the person answers them.
    if (flags.join !== undefined) {
      await steps.join(flags.join).catch((err: unknown) => {
        console.error(`install: ${(err as Error).message}`);
        throw new Error("the configs are written and the probe runs, but the control plane did not take the join. Mint a new token if it said so, then rerun with it");
      });
    }
    console.log();
    const next = new Set<FollowUp>();
    const failed = await steps.credentials(next).then(() => false, (err: unknown) => {
      console.error(`install: ${(err as Error).message}`);
      return true;
    });
    if (next.has("watch") || next.has("config")) await write(next.has("watch") ? ["--github-watch"] : [], withoutDotfiles(args));
    if (next.has("config")) await installer("probe");
    else if (next.has("probe")) await run("systemctl", "try-restart", unitNames.probe);
    if (next.has("control")) await installer("control");
    if (failed) throw new Error("the credentials step failed, after the restarts its writes needed. Fix what it said, then rerun");
    console.log();
    await steps.left();
    return 0;
  } catch (err) {
    if (err instanceof Exit) return err.code;
    throw err;
  }
}

function machineSteps(flags: Flags, manager: PackageManager): InstallSteps {
  return {
    run: (program, args) => new Promise((done, failed) => {
      spawn(program, args, { stdio: "inherit" }).on("error", failed).on("exit", (code) => done(code ?? 1));
    }),
    async join(token) {
      const deployer = parseWorkerConfig(await readJson(paths.deployer), await readControlPlane(paths.controlPlane));
      console.log(`joined the control plane as node ${await joinControlPlane(deployer, token, localApiWhois())}. It follows this node's probe from now on`);
    },
    async credentials(next) {
      const unattended = flags.nonInteractive || !process.stdin.isTTY;
      if (!flags.nonInteractive && !process.stdin.isTTY) console.error("No terminal, so the credentials come from NEXUS_* variables, as deploy/README.md describes, and the rest are skipped.");
      await provision(flags.node === undefined ? "control" : "node", system, unattended ? scripted(process.env) : terminal(), (line) => console.error(line), next);
    },
    async left() {
      console.log(formatLeft(left(await gather(flags, manager))));
    },
  };
}

async function main(args: readonly string[]): Promise<number> {
  const { command, operands, flags } = parseFlags(args);
  if (command === "install" && operands.length === 0 && flags.packageManager !== undefined) {
    return await install(flags, args.slice(1), machineSteps(flags, flags.packageManager));
  }
  if (command === "write") return await write(flags);
  if (command === "rotate" && operands.length === 1) {
    const kind = operands[0]!;
    if (!(rotatable as readonly string[]).includes(kind)) throw new Error(`--rotate ${kind}: give ${rotatable.join(" or ")}`);
    const answers = flags.nonInteractive || !process.stdin.isTTY ? scripted(process.env) : terminal();
    await rotate(kind as Rotatable, await system.exists(configFiles.control) ? "control" : "node", system, answers, (line) => console.error(line));
    return 0;
  }
  if (command === "signed-in" && operands[0] !== undefined) return await signedIn(operands[0]) ? 0 : 1;
  if (command === "healthy" && operands.length === 4) {
    const [unit, config, release, timeoutMs] = operands as [string, string, string, string];
    const listen = listenAddress(await readJson(config, null), config);
    const expected = await readReleaseCommit(release);
    const failure = await awaitHealthy(new URL(`http://${urlHost(listen.host)}:${listen.port}/v1/health`), expected, Number(timeoutMs),
      (ms) => exec("systemctl", ["is-active", "--quiet", unit], { timeout: ms }));
    if (failure !== null) console.error(`install: ${unit} is not healthy at ${expected ?? "a release with no commit"}: ${failure}`);
    return failure === null ? 0 : 1;
  }
  if (command === "registry" && operands[0] !== undefined) {
    const refusal = await registryRefusal(operands[0]);
    if (refusal !== null) console.error(`install: ${refusal}`);
    return refusal === null ? 0 : 1;
  }
  console.error("usage: node src/deploy/setup.ts install|write|signed-in|registry|healthy|rotate claude|github [--node <control device>] [--join <token>] [--admit <device>]... [--add-node <device>=<digest>]... [--peer <device>]... [--dotfiles <git url>] [--non-interactive] [--upgrade] [--package-manager apt|dnf|other], and write also [--github-watch]");
  return 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => {
    console.error(`install: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
