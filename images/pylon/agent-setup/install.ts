/**
 * Installs the agent setup in manifest.json into the image, as user, during docker build:
 *   node /opt/nexus/agent-setup/install.ts
 * and checks an installed setup against the layout the smoke boot derived from the recipe's manifest, with pi
 * loading every extension:
 *   node /opt/nexus/agent-setup/install.ts check '<InstalledAgentSetup as JSON>'
 * Each prints `ok` when the install matches, or one line per mismatch and exits 1. Only the smoke boot starts pi,
 * because pi starts Claude through pi-claude-delegation, and the image would keep that session, its hook events
 * included, which every pylon booted from it would send to its thread.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { basename, installedLayout, parseAgentSetup, type AgentSetup, type Commit, type Harness, type InstalledAgentSetup } from "./manifest.ts";

const home = homedir();
const skillDirs: Record<Harness, string> = { claude: join(home, ".claude", "skills"), pi: join(home, ".agents", "skills") };
const piAgent = join(home, ".pi", "agent");
const piExtensions = join(piAgent, "extensions");
const piPackages = join(piAgent, "packages");
const shepherdr = join(piAgent, "shepherdr");
const shepherdrProfiles = join(shepherdr, "profiles");
const marketplaces = join(import.meta.dirname, "marketplaces");
// The build has open network, and the official marketplace is not part of the pinned setup.
const env = { ...process.env, CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1", DISABLE_AUTOUPDATER: "1" };

/**
 * Once, as user, with the build's open network. Each step fails the build with the command's output:
 * 1. Dotfiles: a depth-1 fetch of the pinned commit into a scratch repo, each skill copied to its harness
 *    directories, each extension to ~/.pi/agent/extensions, each local package to ~/.pi/agent/packages, each
 *    shepherdr profile to ~/.pi/agent/shepherdr/profiles with its model on pylonProfile's provider, marked initialized. The scratch repo is removed: nothing
 *    keeps a dotfiles checkout.
 * 2. Claude: each marketplace fetched the same way into marketplaces/<name> beside this file and added as a
 *    local directory marketplace, which nothing in a pylon tries to update from GitHub. Then each plugin.
 * 3. pi: each package with `pi install`, in manifest order, because pi loads packages in that order.
 * 4. Herdr's integrations, after the plugin installs wrote ~/.claude/settings.json, the order every boot repeats.
 * A plugin whose marketplace at its commit carries another version fails the check that follows, on the node.
 */
async function install(setup: AgentSetup): Promise<void> {
  const dotfiles = await mkdtemp(join(tmpdir(), "agent-setup-dotfiles-"));
  await fetchCommit(setup.dotfiles.url, setup.dotfiles.commit, dotfiles);
  for (const skill of setup.skills) {
    for (const harness of skill.for) await copy(join(dotfiles, skill.path), join(skillDirs[harness], basename(skill.path)));
  }
  for (const extension of setup.pi.extensions) await copy(join(dotfiles, extension), join(piExtensions, basename(extension)));
  for (const local of setup.pi.packages) {
    if (local.kind === "local") await copy(join(dotfiles, local.path), join(piPackages, basename(local.path)));
  }
  for (const profile of setup.pi.shepherdrProfiles) {
    const dir = join(shepherdrProfiles, basename(profile));
    await copy(join(dotfiles, profile), dir);
    await writeFile(join(dir, "profile.json"), pylonProfile(await readFile(join(dir, "profile.json"), "utf8")));
  }
  // pi-shepherdr's first load adds its bundled profiles beside the captured ones unless this marker exists.
  await mkdir(shepherdrProfiles, { recursive: true });
  await writeFile(join(shepherdr, ".profiles-initialized"), "1\n");
  await rm(dotfiles, { recursive: true });

  for (const marketplace of setup.claude.marketplaces) {
    const dir = join(marketplaces, marketplace.name);
    await fetchCommit(marketplace.url, marketplace.commit, dir);
    await run("claude", ["plugin", "marketplace", "add", dir]);
  }
  for (const plugin of setup.claude.plugins) await run("claude", ["plugin", "install", plugin.id]);

  for (const pkg of setup.pi.packages) {
    await run("pi", ["install", pkg.kind === "npm" ? `npm:${pkg.name}@${pkg.version}` : join(piPackages, basename(pkg.path))]);
  }
  await herdrIntegrations();
}

/**
 * A captured shepherdr profile as a pylon runs it. A pylon's pi is signed in only as `openai`, with the harness's
 * ChatGPT login, while a Mac's profile may name `openai-codex`, the same models through the Codex client, which has
 * no login in a pylon. Any other profile comes back byte for byte.
 */
export function pylonProfile(json: string): string {
  const profile = JSON.parse(json) as { model?: unknown };
  if (typeof profile.model !== "string" || !profile.model.startsWith("openai-codex/")) return json;
  return `${JSON.stringify({ ...profile, model: `openai/${profile.model.slice("openai-codex/".length)}` }, null, "\t")}\n`;
}

/**
 * Each Claude hook nexus-claude-hook runs for, the kind it reports or `ask`, its matcher and its timeout in seconds.
 * Claude's idle prompt, 60 seconds after every turn, waits for no one. AskUserQuestion's PermissionRequest waits for an
 * answer from the dashboard while the terminal dialog shows, for as long as a person may take.
 */
export const claudeHooks = [
  ["UserPromptSubmit", "session.turn-started", "", 2],
  ["PostToolUse", "session.heartbeat", "", 2],
  ["Stop", "session.turn-ended", "", 2],
  ["StopFailure", "session.turn-ended", "", 2],
  ["Notification", "session.waiting", "permission_prompt|elicitation_dialog", 2],
  ["SessionEnd", "session.ended", "", 2],
  ["PermissionRequest", "ask", "AskUserQuestion", 86_400],
] as const;

async function herdrIntegrations(): Promise<void> {
  await run("herdr", ["integration", "install", "pi"]);
  await run("herdr", ["integration", "install", "claude"]);
  const path = join(home, ".claude/settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  settings.hooks ??= {};
  for (const [hook, kind, matcher, timeout] of claudeHooks) {
    settings.hooks[hook] = (settings.hooks[hook] ?? []).filter((entry: { hooks?: { command?: string }[] }) => !entry.hooks?.some((h) => h.command?.includes("nexus-claude-hook")));
    settings.hooks[hook].push({ matcher, hooks: [{ type: "command", command: `/usr/local/bin/nexus-claude-hook ${kind}`, timeout }] });
  }
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n");
}

/** The mismatches between the expected layout and this home, and whether pi starts with every extension loaded. */
async function check(expected: InstalledAgentSetup): Promise<readonly string[]> {
  return [...installMismatches(expected, await observe()), ...(await piLoadFailure())];
}

/** Pure, so the agent-setup test covers it: the mismatches between what was installed and installedLayout. */
export function installMismatches(expected: InstalledAgentSetup, actual: InstalledAgentSetup): readonly string[] {
  const what: Record<keyof InstalledAgentSetup, string> = {
    plugins: "Claude plugin",
    claudeSkills: "Claude Code skill",
    piSkills: "pi skill",
    piExtensions: "pi extension",
    piPackages: "pi package",
    shepherdrProfiles: "shepherdr profile",
  };
  const lines = Object.entries(what).flatMap(([key, label]) => {
    const want = expected[key as keyof InstalledAgentSetup];
    const got = actual[key as keyof InstalledAgentSetup];
    return [
      ...want.filter((item) => !got.includes(item)).map((item) => `missing ${label} ${item}`),
      ...got.filter((item) => !want.includes(item)).map((item) => `unexpected ${label} ${item}`),
    ];
  });
  const order = (packages: readonly string[], other: readonly string[]) => packages.filter((p) => other.includes(p)).join(", ");
  if (order(expected.piPackages, actual.piPackages) !== order(actual.piPackages, expected.piPackages)) {
    lines.push(`pi packages are out of order: expected ${expected.piPackages.join(", ")}, got ${actual.piPackages.join(", ")}`);
  }
  return lines;
}

/** This home, read the way installedLayout describes it. */
async function observe(): Promise<InstalledAgentSetup> {
  const listed = JSON.parse((await run("claude", ["plugin", "list", "--json"])).stdout) as { id: string; version: string; scope: string; enabled: boolean }[];
  const settingsFile = join(piAgent, "settings.json");
  const settings = existsSync(settingsFile) ? (JSON.parse(await readFile(settingsFile, "utf8")) as { packages?: string[] }) : {};
  return {
    plugins: listed.filter((p) => p.scope === "user").map((p) => `${p.id} ${p.version} ${p.enabled ? "enabled" : "disabled"}`).sort(),
    claudeSkills: await skillNames(skillDirs.claude),
    piSkills: await skillNames(skillDirs.pi),
    piExtensions: existsSync(piExtensions) ? (await readdir(piExtensions)).sort() : [],
    piPackages: await Promise.all((settings.packages ?? []).map((entry) => installedPackage(entry))),
    shepherdrProfiles: existsSync(shepherdrProfiles) ? (await readdir(shepherdrProfiles)).sort() : [],
  };
}

/** A skill directory without a SKILL.md is listed with that said, so it never matches an expected name. */
async function skillNames(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).map((name) => (existsSync(join(dir, name, "SKILL.md")) ? name : `${name} (no SKILL.md)`)).sort();
}

/**
 * A settings entry as written, unless what it names is not all there: an npm package pinned at a version other than
 * the one installed, or a local package with something missing (localPackageGaps). pi skips both without a word.
 */
export async function installedPackage(entry: string, agentDir = piAgent): Promise<string> {
  if (/^[a-z+]+:/.test(entry)) {
    const npm = /^npm:(@?[^@]+)@(.+)$/.exec(entry);
    if (npm === null) return entry;
    const packageJson = join(agentDir, "npm", "node_modules", npm[1]!, "package.json");
    const installed = existsSync(packageJson) ? (JSON.parse(await readFile(packageJson, "utf8")) as { version: string }).version : "nothing";
    return installed === npm[2] ? entry : `${entry} (installed ${installed})`;
  }
  const gaps = await localPackageGaps(resolve(agentDir, entry.replace(/^~(?=\/|$)/, home)));
  return gaps.length === 0 ? entry : `${entry} (missing ${gaps.join(", ")})`;
}

const piResourceTypes = ["extensions", "skills", "prompts", "themes"] as const;

/**
 * What the local package at `dir` lacks: the directory, a path its package.json `pi` field declares (or, with no `pi`
 * field, an index.ts or index.js when it has none of pi's conventional resource directories), or the SKILL.md of a
 * directory under a skills path, which the image's skill directories need too.
 */
async function localPackageGaps(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return ["its directory"];
  const pi = await readFile(join(dir, "package.json"), "utf8")
    .then((text) => (JSON.parse(text) as { pi?: Partial<Record<string, unknown>> }).pi)
    .catch(() => undefined);
  const declared = piResourceTypes.flatMap((type) => {
    const entries = pi === undefined ? (existsSync(join(dir, type)) ? [type] : []) : pi[type];
    const paths = Array.isArray(entries) ? entries.filter((e): e is string => typeof e === "string" && !/^[-+!]|[*?]/.test(e)) : [];
    return paths.map((path) => ({ type, path: resolve(dir, path) }));
  });
  if (declared.length === 0 && pi === undefined) return existsSync(join(dir, "index.ts")) || existsSync(join(dir, "index.js")) ? [] : ["index.ts"];
  const gaps: string[] = [];
  for (const { type, path } of declared) {
    if (!existsSync(path)) gaps.push(relative(dir, path));
    else if (type === "skills" && (await stat(path)).isDirectory() && !existsSync(join(path, "SKILL.md"))) {
      for (const skill of await readdir(path, { withFileTypes: true })) {
        const skillMd = join(path, skill.name, "SKILL.md");
        if (skill.isDirectory() && !skill.name.startsWith(".") && !existsSync(skillMd)) gaps.push(relative(dir, skillMd));
      }
    }
  }
  return gaps;
}

/**
 * `pi --offline -p` loads every extension and package before it needs a model. With no login it then stops at the
 * missing credential, so that message is the pass, and an extension that throws is named instead. Which message
 * depends on the default provider the packages set: an API key, or an OAuth login such as Codex's.
 */
async function piLoadFailure(): Promise<readonly string[]> {
  const output = await new Promise<string>((done) => {
    const child = execFile("pi", ["--offline", "-p", "hi"], { env, cwd: "/", timeout: 90_000 }, (_err, stdout, stderr) => done(`${stdout}${stderr}`));
    // pi reads a piped stdin as more prompt, so an open one never ends.
    child.stdin?.end();
  });
  if (/^(?:No API key found|Not logged in)/.test(output)) return [];
  return [`pi does not start cleanly: ${output.trim().split("\n").slice(0, 5).join(" | ")}`];
}

async function fetchCommit(url: string, commit: Commit, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run("git", ["-C", dir, "init", "-q"]);
  await run("git", ["-C", dir, "fetch", "-q", "--depth", "1", url, commit]);
  await run("git", ["-C", dir, "checkout", "-q", "--detach", "FETCH_HEAD"]);
  const head = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  if (head !== commit) throw new Error(`${url} at ${commit} checked out ${head}`);
}

/** Links inside the dotfiles become files, so a skill never points into the removed scratch repo. */
async function copy(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, dereference: true, errorOnExist: true, force: false });
}

const execFileAsync = promisify(execFile);

/**
 * Every command runs from /, because Claude Code run from ~, directly or through a pi package, also reads
 * ~/.claude/settings.json as a project's settings and records each enabled plugin a second time, at project scope.
 */
async function run(command: string, args: readonly string[]): Promise<{ stdout: string }> {
  try {
    return await execFileAsync(command, args, { env, cwd: "/", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const { stdout = "", stderr = "", message } = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${command} ${args.join(" ")} failed: ${message}\n${stdout}${stderr}`);
  }
}

if (import.meta.main) {
  const [command, layout] = process.argv.slice(2);
  let mismatches: readonly string[];
  if (command === undefined) {
    const setup = parseAgentSetup(await readFile(join(import.meta.dirname, "manifest.json"), "utf8"));
    await install(setup);
    mismatches = installMismatches(installedLayout(setup), await observe());
  } else if (command === "check" && layout !== undefined) {
    await herdrIntegrations();
    mismatches = await check(JSON.parse(layout) as InstalledAgentSetup);
  } else {
    console.error("usage: node install.ts [check '<InstalledAgentSetup as JSON>']");
    process.exit(64);
  }
  process.stdout.write(mismatches.length === 0 ? "ok\n" : `${mismatches.join("\n")}\n`);
  process.exitCode = mismatches.length === 0 ? 0 : 1;
}
