/**
 * The Mac side of the pylon's agent setup: reads this Mac's Claude Code plugins, skills, pi packages and pi
 * extensions and captures them into images/pylon/agent-setup/manifest.json, which the image build installs.
 *   node src/agent-setup.ts [--dry-run] [--leave-out <kind>:<name>]...
 * It reads ~/.claude, ~/.pi, ~/.agents and the dotfiles repo they link into, asks the remotes what they hold, and
 * writes nothing but the manifest. A thin reader (readMacSetup) collects plain facts and a pure planner
 * (planAgentSetup) holds every policy.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";
import { promisify, parseArgs } from "node:util";
import { z } from "zod";
import {
  agentSetupManifest, asCommit, asDotfilesPath, asHttpsUrl, formatAgentSetup, parseAgentSetup,
  type AgentSetup, type Commit, type DotfilesPath, type Harness, type HttpsUrl, type PiPackage, type PluginId,
} from "../images/pylon/agent-setup/manifest.ts";
import { loadImageRecipe, pylonRecipeDir } from "./image-build.ts";
import { imageIdOf, type ImageRecipe } from "./images.ts";

/** Git blob IDs by POSIX path inside a plugin's directory, as `git ls-tree` prints them. */
export type PluginFiles = ReadonlyMap<string, string>;

/** How the reader showed that a commit is on its remote, or why it could not. */
export type OriginEvidence = { shown: true; by: string } | { shown: false; why: string };

export type MacMarketplace =
  | { name: string; github: null }
  | {
    name: string;
    /** `owner/repo` of the GitHub source in known_marketplaces.json. */
    github: string;
    head: Commit;
    onOrigin: OriginEvidence;
    /**
     * Each plugin of .claude-plugin/marketplace.json at `head`, by name: the files of its source directory at
     * `head` (`git ls-tree`), or null when its source is not a directory in the marketplace repo.
     */
    plugins: ReadonlyMap<string, PluginFiles | null>;
  };

/** What the reader saw on this Mac, before any policy. Every realPath has its symlinks resolved. */
export interface MacSetup {
  /** The repo ~/.claude links into. tracked: `git ls-files`. changed: `git status -uall`, untracked included. Both repo-relative. */
  dotfiles: { root: string; url: HttpsUrl; commit: Commit; onOrigin: OriginEvidence; tracked: ReadonlySet<string>; changed: ReadonlySet<string> };
  claude: {
    /** installed_plugins.json with settings.json `enabledPlugins`. files: the installPath, hashed as git hashes blobs. */
    plugins: readonly { id: string; version: string; enabled: boolean; files: PluginFiles }[];
    /** The marketplaces of the installed plugins, from known_marketplaces.json and each clone. */
    marketplaces: readonly MacMarketplace[];
    /** Entries of ~/.claude/skills that hold a SKILL.md. synced/ and dot entries hold none at top level. */
    skills: readonly { name: string; realPath: string }[];
    /** skillOverrides entries set to "off": not a capability on this Mac, so not shipped to Claude Code. */
    skillsOff: ReadonlySet<string>;
  };
  pi: {
    /** ~/.pi/agent/settings.json `packages`, as written. */
    packages: readonly string[];
    /** npm package name to the version under ~/.pi/agent/npm/node_modules. */
    npmVersions: ReadonlyMap<string, string>;
    /** A settings entry that is a local path, to its real path. */
    localPackages: ReadonlyMap<string, string>;
    /** Entries of ~/.pi/agent/extensions. loads: a .ts or .js file, or a directory with an index.ts or index.js. */
    extensions: readonly { name: string; realPath: string; loads: boolean }[];
    /** ~/.agents/skills and ~/.pi/agent/skills entries that hold a SKILL.md, deduped by realPath. */
    skills: readonly { name: string; realPath: string }[];
    /** settings.json `skills`, each entry with its path, after any +, - or ! prefix, resolved from ~/.pi/agent. */
    skillSettings: readonly { entry: string; realPath: string }[];
  };
  /** For the version skew note only. */
  versions: { claudeCode: string; pi: string };
}

export type LeaveOutKind = "claude-plugin" | "pi-package" | "skill" | "pi-extension";
/** One deliberate leave-out. The capture prints each with its reason, so nothing disappears silently. */
export interface LeaveOut { kind: LeaveOutKind; name: string; why: string }
const leaveOutKinds: readonly LeaveOutKind[] = ["claude-plugin", "pi-package", "skill", "pi-extension"];

/** The settled leave-outs, the only list of them. --leave-out adds to it for one run. */
export const leaveOuts: readonly LeaveOut[] = [
  { kind: "claude-plugin", name: "nexus@claude-mods", why: "recursive inside a pylon" },
  { kind: "claude-plugin", name: "shepherdr@claude-mods", why: "recursive inside a pylon" },
  { kind: "pi-package", name: "npm:@ramtinj95/pi-nexus", why: "recursive inside a pylon" },
  { kind: "pi-package", name: "npm:@howaboua/pi-shepherdr", why: "recursive inside a pylon" },
  { kind: "skill", name: "anki-cards", why: "Mac-only" },
  { kind: "skill", name: "voxcraft-remote", why: "Mac-only" },
  { kind: "skill", name: "macmini-handoff", why: "Mac-only" },
  { kind: "pi-extension", name: "atuin.ts", why: "needs the atuin binary" },
  { kind: "pi-extension", name: "herdr-agent-state.ts", why: "herdr integration install pi writes its own" },
];

export type Capture =
  | { kind: "captured"; setup: AgentSetup; leftOut: readonly LeaveOut[]; notes: readonly string[] }
  | { kind: "refused"; problems: readonly string[] };

/** Claude Code's own markers in a plugin's cache directory, never in a marketplace. */
const pluginMarkers = new Set([".in_use", ".orphaned_at"]);

/**
 * Pure. Ships every enabled plugin, pi package, loading pi extension and skill that `rules` does not leave out.
 * Refuses, listing every problem rather than the first, when an item would ship but:
 * - its real path is outside the dotfiles repo, or any file under it is uncommitted or changed there, or the
 *   dotfiles HEAD is not shown to be on origin. The build fetches the public repo, so only pushed, committed
 *   bytes can reach it;
 * - its marketplace is not a GitHub repo, or its HEAD is not shown to be on GitHub, or the plugin's installed copy
 *   differs from its directory at the marketplace's HEAD (Claude's .in_use and .orphaned_at markers aside): the fix
 *   is `claude plugin update <id>` on the Mac, then capture again;
 * - it is a pi package source other than npm: or a local path, or an npm package with no installed version;
 * - it is a pi `skills` setting other than a `-path` exclusion, which the capture does not reproduce;
 * - its name differs from its directory's name, which is the name the image installs it under;
 * - two shipped skills, extensions or local packages share a name, or anything else the manifest parser refuses.
 * An extension entry that loads nothing is not a capability and is skipped by definition, as is a directory that is
 * also a local package, which ships once, as the package. A skill goes to Claude Code when ~/.claude/skills has it and
 * skillOverrides does not turn it off, and to pi when ~/.agents/skills or ~/.pi/agent/skills has it and no `-path`
 * exclusion names it. A leave-out that matches nothing comes back as a note, so a stale entry is visible without
 * blocking a capture.
 */
export function planAgentSetup(mac: MacSetup, rules: readonly LeaveOut[]): Capture {
  const problems: string[] = [];
  const matched = new Set<LeaveOut>();
  const leftOut = (kind: LeaveOutKind, name: string): boolean => {
    const rule = rules.find((r) => r.kind === kind && r.name === name);
    if (rule !== undefined) matched.add(rule);
    return rule !== undefined;
  };
  const { dotfiles } = mac;
  let fromDotfiles = false;
  /**
   * The item's path in the dotfiles repo, or null after recording why it cannot ship from there. A skill or an
   * extension installs under its directory's name, so that name must be the one it has on this Mac.
   */
  const inDotfiles = (what: string, name: string, realPath: string, installedByName: boolean): DotfilesPath | null => {
    fromDotfiles = true;
    const rel = relative(dotfiles.root, realPath).split(sep).join("/");
    if (rel === "" || rel === ".." || rel.startsWith("../")) {
      problems.push(`${what} ${name}: ${realPath} is outside ${dotfiles.root}`);
      return null;
    }
    const under = (path: string) => path === rel || path.startsWith(`${rel}/`);
    if (![...dotfiles.tracked].some(under)) problems.push(`${what} ${name}: ${rel} is not committed in ${dotfiles.root}`);
    else if ([...dotfiles.changed].some(under)) problems.push(`${what} ${name}: ${rel} has uncommitted changes in ${dotfiles.root}`);
    if (installedByName && posix.basename(rel) !== name) problems.push(`${what} ${name}: it is ${rel}, which the image would install as ${posix.basename(rel)}`);
    try {
      return asDotfilesPath(rel, `${what} ${name}`);
    } catch (err) {
      problems.push((err as Error).message);
      return null;
    }
  };

  const plugins: { id: PluginId; version: string }[] = [];
  const marketplaces = new Map<string, AgentSetup["claude"]["marketplaces"][number]>();
  for (const plugin of mac.claude.plugins) {
    if (!plugin.enabled || leftOut("claude-plugin", plugin.id)) continue;
    const at = plugin.id.lastIndexOf("@");
    const [name, marketplaceName] = [plugin.id.slice(0, at), plugin.id.slice(at + 1)];
    const marketplace = mac.claude.marketplaces.find((m) => m.name === marketplaceName);
    if (marketplace === undefined) {
      problems.push(`claude plugin ${plugin.id}: this Mac knows no marketplace ${marketplaceName}`);
      continue;
    }
    if (marketplace.github === null) {
      problems.push(`claude plugin ${plugin.id}: its marketplace ${marketplaceName} is not a GitHub repo, so the image build cannot fetch it`);
      continue;
    }
    const short = marketplace.head.slice(0, 7);
    const atHead = marketplace.plugins.get(name);
    if (atHead === undefined) problems.push(`claude plugin ${plugin.id}: marketplace ${marketplaceName} at ${short} does not list it`);
    else if (atHead === null) problems.push(`claude plugin ${plugin.id}: marketplace ${marketplaceName} lists it with a source outside the marketplace repo`);
    else if (!samePluginFiles(plugin.files, atHead)) {
      problems.push(`claude plugin ${plugin.id}: the installed copy differs from marketplace ${marketplaceName} at ${short}. Run \`claude plugin update ${plugin.id}\`, then capture again`);
    } else plugins.push({ id: plugin.id as PluginId, version: plugin.version });
    if (!marketplaces.has(marketplaceName)) {
      if (!marketplace.onOrigin.shown) {
        problems.push(`marketplace ${marketplaceName}: HEAD ${short} is not shown to be on GitHub (${marketplace.onOrigin.why}). Run \`claude plugin marketplace update ${marketplaceName}\`, then capture again`);
      }
      marketplaces.set(marketplaceName, { name: marketplaceName, url: `https://github.com/${marketplace.github}`, commit: marketplace.head });
    }
  }

  const exclusions = mac.pi.skillSettings.flatMap(({ entry, realPath }) => {
    if (entry.startsWith("-")) return [realPath];
    problems.push(`pi skills setting ${JSON.stringify(entry)}: only -path exclusions are captured`);
    return [];
  });
  const skillHarnesses = new Map<string, { names: Set<string>; for: Set<Harness> }>();
  const addSkill = (harness: Harness, { name, realPath }: { name: string; realPath: string }) => {
    const entry = skillHarnesses.get(realPath) ?? { names: new Set<string>(), for: new Set<Harness>() };
    entry.names.add(name);
    entry.for.add(harness);
    skillHarnesses.set(realPath, entry);
  };
  for (const skill of mac.claude.skills) if (!mac.claude.skillsOff.has(skill.name)) addSkill("claude", skill);
  for (const skill of mac.pi.skills) {
    if (!exclusions.some((path) => path === skill.realPath || path === join(skill.realPath, "SKILL.md"))) addSkill("pi", skill);
  }
  const skills: AgentSetup["skills"][number][] = [];
  for (const [realPath, { names, for: harnesses }] of skillHarnesses) {
    const kept = [...names].filter((name) => !leftOut("skill", name));
    if (kept.length === 0) continue;
    const paths = kept.map((name) => inDotfiles("skill", name, realPath, true));
    const [path] = paths;
    if (path != null && !paths.includes(null)) skills.push({ path, for: [...harnesses] });
  }

  const packages: PiPackage[] = [];
  for (const entry of mac.pi.packages) {
    if (leftOut("pi-package", entry)) continue;
    const local = mac.pi.localPackages.get(entry);
    if (entry.startsWith("npm:")) {
      const name = /^npm:(@?[^@]+)/.exec(entry)![1]!;
      const version = mac.pi.npmVersions.get(name);
      if (version === undefined) problems.push(`pi package ${entry}: no version of ${name} is installed under ~/.pi/agent/npm`);
      else packages.push({ kind: "npm", name, version });
    } else if (local !== undefined) {
      const path = inDotfiles("pi package", entry, local, false);
      if (path !== null) packages.push({ kind: "local", path });
    } else problems.push(`pi package ${entry}: only npm: and local packages are captured`);
  }

  const localPaths = new Set(mac.pi.localPackages.values());
  const extensions: DotfilesPath[] = [];
  for (const extension of mac.pi.extensions) {
    if (!extension.loads || localPaths.has(extension.realPath) || leftOut("pi-extension", extension.name)) continue;
    const path = inDotfiles("pi extension", extension.name, extension.realPath, true);
    if (path !== null) extensions.push(path);
  }

  if (fromDotfiles && !dotfiles.onOrigin.shown) {
    problems.push(`dotfiles: HEAD ${dotfiles.commit.slice(0, 7)} is not shown to be on ${dotfiles.url} (${dotfiles.onOrigin.why}), so the image build may not fetch it. Push it, or fetch so this clone knows origin's branches`);
  }
  const candidate: AgentSetup = {
    dotfiles: { url: dotfiles.url, commit: dotfiles.commit },
    claude: { marketplaces: [...marketplaces.values()], plugins },
    pi: { packages, extensions },
    skills,
  };
  let setup: AgentSetup | undefined;
  try {
    setup = parseAgentSetup(formatAgentSetup(candidate));
  } catch (err) {
    problems.push(`the manifest would not parse: ${(err as Error).message}`);
  }
  if (problems.length > 0 || setup === undefined) return { kind: "refused", problems };
  return {
    kind: "captured",
    setup,
    leftOut: rules.filter((rule) => matched.has(rule)),
    notes: rules.filter((rule) => !matched.has(rule)).map((rule) => `leave-out ${rule.kind}:${rule.name} matches nothing on this Mac`),
  };
}

function samePluginFiles(installed: PluginFiles, atHead: PluginFiles): boolean {
  const files = [...installed].filter(([path]) => !pluginMarkers.has(path.split("/")[0]!));
  return files.length === atHead.size && files.every(([path, blob]) => atHead.get(path) === blob);
}

// The reader. Everything below only reads: git runs without optional locks, and nothing runs that updates a
// marketplace, a plugin or a remote-tracking branch.

const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
const execFileAsync = promisify(execFile);

async function output(command: string, args: readonly string[], cwd?: string): Promise<string> {
  try {
    return (await execFileAsync(command, args, { cwd, env: { ...gitEnv, PI_OFFLINE: "1" }, maxBuffer: 256 * 1024 * 1024 })).stdout;
  } catch (err) {
    const { stderr = "", message } = err as { stderr?: string; message: string };
    throw new Error(`${command} ${args.join(" ")}: ${message}${stderr === "" ? "" : `\n${stderr}`}`);
  }
}

async function succeeds(command: string, args: readonly string[]): Promise<boolean> {
  return output(command, args).then(() => true, () => false);
}

/** The commits among `shas` that the clone at `dir` has, asked in one `git cat-file --batch-check`. */
async function commitsIn(dir: string, shas: readonly string[]): Promise<string[]> {
  const asked = execFileAsync("git", ["-C", dir, "cat-file", "--batch-check"], { env: gitEnv, maxBuffer: 64 * 1024 * 1024 });
  asked.child.stdin!.end(shas.map((sha) => `${sha}\n`).join(""));
  return (await asked).stdout.split("\n").flatMap((line) => (/^([0-9a-f]{40}) commit /.exec(line)?.slice(1, 2) ?? []));
}

const git = (dir: string, ...args: string[]) => output("git", ["-C", dir, ...args]);

/** `git@github.com:o/r.git`, `ssh://git@github.com/o/r` and `https://github.com/o/r.git` all read https://github.com/o/r. */
export function httpsRemote(remote: string): HttpsUrl {
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(remote);
  const url = scp !== null ? `https://${scp[1]}/${scp[2]}` : remote.replace(/^(?:ssh|git):\/\/(?:[^@/]+@)?/, "https://");
  return asHttpsUrl(url.replace(/\.git$/, "").replace(/\/$/, ""), `remote ${remote}`);
}

/**
 * Whether `commit` is on `url`, shown without fetching: it is a branch or tag tip there, or an ancestor of a tip
 * this clone already has, or GitHub's compare API reports it behind or at the default branch.
 */
async function onOrigin(dir: string, url: HttpsUrl, commit: Commit): Promise<OriginEvidence> {
  const advertised = (await output("git", ["ls-remote", url, "HEAD", "refs/heads/*", "refs/tags/*"]))
    .split("\n").filter((line) => line !== "").map((line) => line.split("\t") as [string, string]);
  if (advertised.some(([sha]) => sha === commit)) return { shown: true, by: "git ls-remote" };
  for (const sha of await commitsIn(dir, [...new Set(advertised.map(([sha]) => sha))])) {
    if (await succeeds("git", ["-C", dir, "merge-base", "--is-ancestor", commit, sha])) return { shown: true, by: `this clone's history of ${sha.slice(0, 7)}` };
  }
  const head = advertised.find(([, ref]) => ref === "HEAD")?.[0];
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(url)?.[1];
  if (head === undefined || github === undefined) return { shown: false, why: "no branch or tag there is it or a descendant this clone has" };
  const response = await fetch(`https://api.github.com/repos/${github}/compare/${commit}...${head}`, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) return { shown: false, why: `this clone lacks origin's tips, and GitHub's compare API answered ${response.status}` };
  const { status } = (await response.json()) as { status: string };
  if (status === "identical" || status === "ahead") return { shown: true, by: `GitHub's compare API, as an ancestor of ${head.slice(0, 7)}` };
  return { shown: false, why: `GitHub's compare API says it has ${status} from the default branch` };
}

/** Git's blob ID of each file under `dir`, by POSIX path. A symlink's blob is its target, as git stores it. */
async function hashTree(dir: string): Promise<PluginFiles> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const full = join(entry.parentPath, entry.name);
    const content = entry.isSymbolicLink() ? Buffer.from(await readlink(full)) : await readFile(full);
    const blob = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    files.set(relative(dir, full).split(sep).join("/"), blob);
  }
  return files;
}

async function treeAt(dir: string, commit: Commit, source: string): Promise<PluginFiles> {
  const prefix = posix.normalize(source);
  const listing = await git(dir, "ls-tree", "-r", "-z", commit, ...(prefix === "." ? [] : ["--", prefix]));
  const files = new Map<string, string>();
  for (const line of listing.split("\0").filter((l) => l !== "")) {
    const [meta, path] = line.split("\t") as [string, string];
    files.set(prefix === "." ? path : posix.relative(prefix, path), meta.split(" ")[2]!);
  }
  return files;
}

const installedPluginsSchema = z.object({
  version: z.literal(2),
  plugins: z.record(z.string(), z.array(z.object({ scope: z.string(), installPath: z.string(), version: z.string() }))),
});
const knownMarketplacesSchema = z.record(z.string(), z.object({
  source: z.object({ source: z.string(), repo: z.string().optional() }),
  installLocation: z.string(),
}));
const marketplaceJsonSchema = z.object({ plugins: z.array(z.object({ name: z.string(), source: z.unknown() })) });
const claudeSettingsSchema = z.object({
  enabledPlugins: z.record(z.string(), z.boolean()).default({}),
  skillOverrides: z.record(z.string(), z.string()).default({}),
});
const piSettingsSchema = z.object({ packages: z.array(z.string()).default([]), skills: z.array(z.string()).default([]) });

const readJson = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => schema.parse(JSON.parse(await readFile(path, "utf8")));

/** Entries of `dir` that hold a SKILL.md, by name, sorted. */
async function skillsIn(dir: string): Promise<{ name: string; realPath: string }[]> {
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((name) => !name.startsWith(".") && existsSync(join(dir, name, "SKILL.md"))).sort();
  return Promise.all(names.map(async (name) => ({ name, realPath: await realpath(join(dir, name)) })));
}

/**
 * The shell: reads the Mac (git, Claude Code's and pi's JSON files, realpaths). It reads Claude Code's plugin files
 * rather than running `claude plugin list`, because a Claude Code start may update a marketplace with autoUpdate on.
 * Throws on a missing input.
 */
export async function readMacSetup(home: string): Promise<MacSetup> {
  const claudeDir = join(home, ".claude");
  const root = (await git(await realpath(claudeDir), "rev-parse", "--show-toplevel")).trim();
  const url = httpsRemote((await git(root, "remote", "get-url", "origin")).trim());
  const commit = asCommit((await git(root, "rev-parse", "HEAD")).trim(), "dotfiles HEAD");
  const tracked = new Set((await git(root, "ls-files", "-z")).split("\0").filter((p) => p !== ""));
  const changed = new Set<string>();
  const status = (await git(root, "status", "--porcelain=v1", "-z", "-uall")).split("\0");
  for (let i = 0; i < status.length; i++) {
    const record = status[i]!;
    if (record === "") continue;
    changed.add(record.slice(3));
    if (/^[RC]/.test(record)) changed.add(status[++i]!);
  }

  const claudeSettings = await readJson(join(claudeDir, "settings.json"), claudeSettingsSchema);
  const installed = await readJson(join(claudeDir, "plugins", "installed_plugins.json"), installedPluginsSchema);
  const plugins = await Promise.all(Object.entries(installed.plugins).flatMap(([id, installs]) =>
    installs.filter((i) => i.scope === "user").map(async (i) => ({
      id, version: i.version, enabled: claudeSettings.enabledPlugins[id] === true, files: await hashTree(i.installPath),
    }))));
  const known = await readJson(join(claudeDir, "plugins", "known_marketplaces.json"), knownMarketplacesSchema);
  const marketplaceNames = [...new Set(plugins.map((p) => p.id.slice(p.id.lastIndexOf("@") + 1)))].sort();
  const marketplaces = await Promise.all(marketplaceNames.flatMap((name): Promise<MacMarketplace>[] => {
    const entry = known[name];
    if (entry === undefined) return [];
    return [(async (): Promise<MacMarketplace> => {
      if (entry.source.source !== "github" || entry.source.repo === undefined) return { name, github: null };
      const dir = entry.installLocation;
      const head = asCommit((await git(dir, "rev-parse", "HEAD")).trim(), `marketplace ${name} HEAD`);
      const listed = marketplaceJsonSchema.parse(JSON.parse(await git(dir, "show", `${head}:.claude-plugin/marketplace.json`)));
      const files = new Map<string, PluginFiles | null>();
      for (const plugin of listed.plugins) {
        files.set(plugin.name, typeof plugin.source === "string" && plugin.source.startsWith("./") ? await treeAt(dir, head, plugin.source) : null);
      }
      return { name, github: entry.source.repo, head, onOrigin: await onOrigin(dir, asHttpsUrl(`https://github.com/${entry.source.repo}`, `marketplace ${name}`), head), plugins: files };
    })()];
  }));

  const piAgent = join(home, ".pi", "agent");
  const piSettings = await readJson(join(piAgent, "settings.json"), piSettingsSchema);
  const resolveSetting = async (path: string) => {
    const absolute = resolve(piAgent, path.replace(/^~(?=\/|$)/, home));
    return existsSync(absolute) ? realpath(absolute) : absolute;
  };
  const npmVersions = new Map<string, string>();
  const localPackages = new Map<string, string>();
  for (const entry of piSettings.packages) {
    const npm = /^npm:(@?[^@]+)/.exec(entry);
    if (npm !== null) {
      const packageJson = join(piAgent, "npm", "node_modules", npm[1]!, "package.json");
      if (existsSync(packageJson)) npmVersions.set(npm[1]!, (await readJson(packageJson, z.object({ version: z.string() }))).version);
    } else if (!/^[a-z+]+:/.test(entry) && existsSync(resolve(piAgent, entry))) {
      localPackages.set(entry, await resolveSetting(entry));
    }
  }
  const extensionsDir = join(piAgent, "extensions");
  const extensions = await Promise.all((existsSync(extensionsDir) ? await readdir(extensionsDir) : []).sort().map(async (name) => {
    const realPath = await realpath(join(extensionsDir, name));
    const loads = (await stat(realPath)).isDirectory()
      ? existsSync(join(realPath, "index.ts")) || existsSync(join(realPath, "index.js"))
      : /\.[tj]s$/.test(name);
    return { name, realPath, loads };
  }));
  const piSkills = [...await skillsIn(join(home, ".agents", "skills")), ...await skillsIn(join(piAgent, "skills"))]
    .filter((skill, i, all) => all.findIndex((s) => s.realPath === skill.realPath) === i);

  const version = async (command: string) => (await output(command, ["--version"])).trim().split(" ")[0]!;
  return {
    dotfiles: { root, url, commit, onOrigin: await onOrigin(root, url, commit), tracked, changed },
    claude: {
      plugins: plugins.sort((a, b) => (a.id < b.id ? -1 : 1)),
      marketplaces,
      skills: await skillsIn(join(claudeDir, "skills")),
      skillsOff: new Set(Object.entries(claudeSettings.skillOverrides).filter(([, v]) => v === "off").map(([k]) => k)),
    },
    pi: {
      packages: piSettings.packages,
      npmVersions,
      localPackages,
      extensions,
      skills: piSkills,
      skillSettings: await Promise.all(piSettings.skills.map(async (entry) => ({ entry, realPath: await resolveSetting(entry.replace(/^[-+!]/, "")) }))),
    },
    versions: { claudeCode: await version("claude"), pi: await version("pi") },
  };
}

/** `<kind>:<name>`, split at the first colon, since pi package names such as npm:x carry their own. */
export function parseLeaveOut(flag: string): LeaveOut {
  const at = flag.indexOf(":");
  const kind = flag.slice(0, at) as LeaveOutKind;
  if (at < 1 || at === flag.length - 1 || !leaveOutKinds.includes(kind)) {
    throw new Error(`--leave-out takes <kind>:<name> with kind one of ${leaveOutKinds.join(", ")}, such as skill:ramtin-mode`);
  }
  return { kind, name: flag.slice(at + 1), why: "left out on the command line" };
}

/** The lines after the first: what ships, what is left out and why, and anything worth a look. */
export function captureSummary(capture: Extract<Capture, { kind: "captured" }>, mac: MacSetup, pins: ImageRecipe["pins"]): string {
  const { setup } = capture;
  const evidence = mac.dotfiles.onOrigin.shown ? `, on origin by ${mac.dotfiles.onOrigin.by}` : "";
  const forHarness = (h: Harness) => setup.skills.filter((s) => s.for.includes(h)).length;
  const kindLabel: Record<LeaveOutKind, string> = { "claude-plugin": "claude plugin", "pi-package": "pi package", skill: "skill", "pi-extension": "pi extension" };
  const notes = [
    ...capture.notes,
    ...(mac.versions.claudeCode === pins.claudeCode ? [] : [`this Mac runs Claude Code ${mac.versions.claudeCode} and the image pins ${pins.claudeCode} (pins.json is yours to change)`]),
    ...(mac.versions.pi === pins.pi ? [] : [`this Mac runs pi ${mac.versions.pi} and the image pins ${pins.pi} (pins.json is yours to change)`]),
  ];
  const rows: [string, readonly string[]][] = [
    ["dotfiles", [`${setup.dotfiles.url} at ${setup.dotfiles.commit.slice(0, 7)}${evidence}`]],
    ["claude", setup.claude.plugins.map((p) => `${p.id} ${p.version}`)],
    ["skills", [`${setup.skills.length}: ${forHarness("claude")} for Claude Code, ${forHarness("pi")} for pi`]],
    ["pi", [`${setup.pi.packages.length} packages, ${setup.pi.extensions.length} extensions`]],
    ["left out", capture.leftOut.map((rule) => `${kindLabel[rule.kind]} ${rule.name}: ${rule.why}`)],
    ["note", notes],
  ];
  return rows.flatMap(([label, lines]) => lines.map((line, i) => `  ${(i === 0 ? label : "").padEnd(10)} ${line}\n`)).join("");
}

if (import.meta.main) {
  let values: { "dry-run"?: boolean; "leave-out"?: string[] };
  let extra: LeaveOut[];
  try {
    ({ values } = parseArgs({ options: { "dry-run": { type: "boolean" }, "leave-out": { type: "string", multiple: true } }, strict: true }));
    extra = (values["leave-out"] ?? []).map(parseLeaveOut);
  } catch (err) {
    console.error(`${(err as Error).message}\nusage: node src/agent-setup.ts [--dry-run] [--leave-out <kind>:<name>]...`);
    process.exit(64);
  }
  const mac = await readMacSetup(homedir());
  const capture = planAgentSetup(mac, [...leaveOuts, ...extra]);
  if (capture.kind === "refused") {
    process.stderr.write(`${capture.problems.map((p) => `  ${p}\n`).join("")}Wrote nothing: ${capture.problems.length} problems above.\n`);
    process.exit(1);
  }
  const recipe = await loadImageRecipe();
  const file = join(pylonRecipeDir, agentSetupManifest);
  const manifest = formatAgentSetup(capture.setup);
  const before = imageIdOf(recipe);
  const after = imageIdOf({ ...recipe, files: [...recipe.files.filter((f) => f.path !== agentSetupManifest), { path: agentSetupManifest, content: manifest }] });
  const shown = relative(process.cwd(), file);
  if (before === after) process.stdout.write(`${shown} is unchanged. The image stays ${before}.\n`);
  else if (values["dry-run"] === true) process.stdout.write(`Would write ${shown}, which makes the image ${after} (now ${before}). Dry run: wrote nothing.\n`);
  else {
    await writeFile(file, manifest);
    process.stdout.write(`Wrote ${shown}. The image is now ${after} (was ${before}).\n`);
  }
  process.stdout.write(captureSummary(capture, mac, recipe.pins));
}

