/**
 * The agent setup baked into the pylon image: this Mac's Claude Code plugins, skills, pi packages and pi
 * extensions, as pinned refs and never as file contents. src/agent-setup.ts captures it on the Mac into
 * manifest.json, install.ts installs it during docker build, and src/image-build.ts refuses a recipe whose
 * manifest does not parse and derives the agent smoke check from it. The module imports nothing, so the
 * image's Node runs it as it is.
 */

/** A full 40-hex git commit ID. Short IDs are refused: the build fetches exactly this object. */
export type Commit = string & { readonly __commit: unique symbol };
/** A POSIX path inside the dotfiles repo, with no empty, `.` or `..` part. Its basename is the installed name. */
export type DotfilesPath = string & { readonly __dotfilesPath: unique symbol };
export type Harness = "claude" | "pi";
/** `<plugin>@<marketplace>`, as `claude plugin install` takes it. */
export type PluginId = `${string}@${string}`;

/**
 * This Mac's agent capabilities as pinned refs. Every fetched thing is pinned: the dotfiles repo and each Claude
 * marketplace by commit, each plugin and npm pi package by exact version, which the build checks after installing.
 * Arrays are in canonical order (formatAgentSetup), except pi.packages, which keeps the Mac's settings order
 * because pi loads packages in that order.
 */
export interface AgentSetup {
  /** The public dotfiles repo, fetched over HTTPS at `commit` during docker build. Every path below is in it. */
  dotfiles: { url: HttpsUrl; commit: Commit };
  claude: {
    /** Cloned at `commit` into /opt/nexus/agent-setup/marketplaces/<name> and added as a local directory marketplace. */
    marketplaces: readonly { name: string; url: HttpsUrl; commit: Commit }[];
    /** `claude plugin install <id>`. The id's marketplace is one of `marketplaces`. Enabled, as on the Mac. */
    plugins: readonly { id: PluginId; version: string }[];
  };
  pi: {
    packages: readonly PiPackage[];
    /** Copied into ~/.pi/agent/extensions, which pi auto-loads: a .ts or .js file or a directory with an index file. */
    extensions: readonly DotfilesPath[];
  };
  /** Each skill directory once. Copied to ~/.claude/skills/<name> for claude and ~/.agents/skills/<name> for pi. */
  skills: readonly { path: DotfilesPath; for: readonly Harness[] }[];
}

export type HttpsUrl = `https://${string}`;

export type PiPackage =
  | { kind: "npm"; name: string; version: string } // pi install npm:<name>@<version>
  | { kind: "local"; path: DotfilesPath }; // copied to ~/.pi/agent/packages/<name>, then pi install <that dir>

/** The recipe path the image build and the capture both name. */
export const agentSetupManifest = "agent-setup/manifest.json";

const harnessOrder: readonly Harness[] = ["claude", "pi"];

/** The installed name of a dotfiles path. */
export function basename(path: DotfilesPath): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The boundary for the manifest, used by all three readers. Throws naming the field on: an unknown or missing key,
 * a commit that is not 40 hex, a URL that is not https, a path with an empty, `.` or `..` part, two skills,
 * extensions or local packages with one basename, a plugin whose marketplace is not listed, a skill with an empty
 * or repeated `for`.
 */
export function parseAgentSetup(json: string): AgentSetup {
  const root = fields(JSON.parse(json) as unknown, "manifest", ["dotfiles", "claude", "pi", "skills"]);
  const dotfiles = fields(root.dotfiles, "dotfiles", ["url", "commit"]);
  const claude = fields(root.claude, "claude", ["marketplaces", "plugins"]);
  const marketplaces = list(claude.marketplaces, "claude.marketplaces").map((value, i) => {
    const field = `claude.marketplaces[${i}]`;
    const m = fields(value, field, ["name", "url", "commit"]);
    return { name: matching(m.name, `${field}.name`, namePattern), url: asHttpsUrl(m.url, `${field}.url`), commit: asCommit(m.commit, `${field}.commit`) };
  });
  unique(marketplaces.map((m) => m.name), "claude.marketplaces", "marketplace name");
  const plugins = list(claude.plugins, "claude.plugins").map((value, i) => {
    const field = `claude.plugins[${i}]`;
    const p = fields(value, field, ["id", "version"]);
    const id = matching(p.id, `${field}.id`, /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/) as PluginId;
    const marketplace = id.slice(id.indexOf("@") + 1);
    if (!marketplaces.some((m) => m.name === marketplace)) throw new Error(`${field}.id: marketplace ${marketplace} is not in claude.marketplaces`);
    return { id, version: matching(p.version, `${field}.version`, versionPattern) };
  });
  unique(plugins.map((p) => p.id), "claude.plugins", "plugin");
  const pi = fields(root.pi, "pi", ["packages", "extensions"]);
  const packages = list(pi.packages, "pi.packages").map((value, i): PiPackage => {
    const field = `pi.packages[${i}]`;
    const kind = fields(value, field, ["kind"], true).kind;
    if (kind === "npm") {
      const p = fields(value, field, ["kind", "name", "version"]);
      return { kind, name: matching(p.name, `${field}.name`, npmNamePattern), version: matching(p.version, `${field}.version`, semverPattern) };
    }
    if (kind === "local") return { kind, path: asDotfilesPath(fields(value, field, ["kind", "path"]).path, `${field}.path`) };
    throw new Error(`${field}.kind: expected "npm" or "local", got ${JSON.stringify(kind)}`);
  });
  unique(packages.flatMap((p) => (p.kind === "npm" ? [p.name] : [])), "pi.packages", "npm package");
  unique(packages.flatMap((p) => (p.kind === "local" ? [basename(p.path)] : [])), "pi.packages", "local package name");
  const extensions = list(pi.extensions, "pi.extensions").map((value, i) => asDotfilesPath(value, `pi.extensions[${i}]`));
  unique(extensions.map(basename), "pi.extensions", "extension name");
  const skills = list(root.skills, "skills").map((value, i) => {
    const field = `skills[${i}]`;
    const s = fields(value, field, ["path", "for"]);
    const harnesses = list(s.for, `${field}.for`).map((h, j) => {
      if (h !== "claude" && h !== "pi") throw new Error(`${field}.for[${j}]: expected "claude" or "pi", got ${JSON.stringify(h)}`);
      return h;
    });
    if (harnesses.length === 0) throw new Error(`${field}.for: names no harness`);
    unique(harnesses, `${field}.for`, "harness");
    return { path: asDotfilesPath(s.path, `${field}.path`), for: harnesses };
  });
  unique(skills.map((s) => basename(s.path)), "skills", "skill name");
  return {
    dotfiles: { url: asHttpsUrl(dotfiles.url, "dotfiles.url"), commit: asCommit(dotfiles.commit, "dotfiles.commit") },
    claude: { marketplaces, plugins },
    pi: { packages, extensions },
    skills,
  };
}

/**
 * Canonical JSON with a trailing newline: keys in a fixed order, arrays sorted except pi.packages, and one entry
 * per line, so a refresh's diff reads as the entries that changed.
 */
export function formatAgentSetup(setup: AgentSetup): string {
  const entries = (items: readonly unknown[], indent: string) =>
    items.length === 0 ? "[]" : `[\n${items.map((item) => `${indent}  ${JSON.stringify(item)}`).join(",\n")}\n${indent}]`;
  const marketplaces = sorted(setup.claude.marketplaces, (m) => m.name).map((m) => ({ name: m.name, url: m.url, commit: m.commit }));
  const plugins = sorted(setup.claude.plugins, (p) => p.id).map((p) => ({ id: p.id, version: p.version }));
  const packages = setup.pi.packages.map((p) => (p.kind === "npm" ? { kind: p.kind, name: p.name, version: p.version } : { kind: p.kind, path: p.path }));
  const skills = sorted(setup.skills, (s) => s.path).map((s) => ({ path: s.path, for: harnessOrder.filter((h) => s.for.includes(h)) }));
  return [
    "{",
    `  "dotfiles": ${JSON.stringify({ url: setup.dotfiles.url, commit: setup.dotfiles.commit })},`,
    `  "claude": {`,
    `    "marketplaces": ${entries(marketplaces, "    ")},`,
    `    "plugins": ${entries(plugins, "    ")}`,
    "  },",
    `  "pi": {`,
    `    "packages": ${entries(packages, "    ")},`,
    `    "extensions": ${entries(sorted(setup.pi.extensions, (path) => path), "    ")}`,
    "  },",
    `  "skills": ${entries(skills, "  ")}`,
    "}",
    "",
  ].join("\n");
}

/** What a correct install leaves, derived once for the installer's own check and for the smoke boot. */
export interface InstalledAgentSetup {
  /** `<id> <version> enabled`, sorted. */
  plugins: readonly string[];
  /** Directory names under ~/.claude/skills, sorted. */
  claudeSkills: readonly string[];
  /** Directory names under ~/.agents/skills, sorted. */
  piSkills: readonly string[];
  /** Entries under ~/.pi/agent/extensions, Herdr's herdr-agent-state.ts included, sorted. */
  piExtensions: readonly string[];
  /** ~/.pi/agent/settings.json `packages` as pi install writes them, in order, each npm one at its installed version. */
  piPackages: readonly string[];
}

/** `herdr integration install pi` writes this extension, at build time and on every boot. */
export const herdrPiExtension = "herdr-agent-state.ts";

export function installedLayout(setup: AgentSetup): InstalledAgentSetup {
  const skillsFor = (harness: Harness) => sorted(setup.skills.filter((s) => s.for.includes(harness)).map((s) => basename(s.path)), (name) => name);
  return {
    plugins: sorted(setup.claude.plugins.map((p) => `${p.id} ${p.version} enabled`), (line) => line),
    claudeSkills: skillsFor("claude"),
    piSkills: skillsFor("pi"),
    piExtensions: sorted([...setup.pi.extensions.map(basename), herdrPiExtension], (name) => name),
    piPackages: setup.pi.packages.map((p) => (p.kind === "npm" ? `npm:${p.name}@${p.version}` : `packages/${basename(p.path)}`)),
  };
}

export function asCommit(value: unknown, field: string): Commit {
  return matching(value, field, /^[0-9a-f]{40}$/) as Commit;
}

export function asDotfilesPath(value: unknown, field: string): DotfilesPath {
  const path = matching(value, field, /^[^/].*$/);
  if (!path.split("/").every((part) => namePattern.test(part))) {
    throw new Error(`${field}: ${JSON.stringify(path)} is not a plain relative path of letters, digits and ._@+-`);
  }
  return path as DotfilesPath;
}

export function asHttpsUrl(value: unknown, field: string): HttpsUrl {
  return matching(value, field, /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~@%+-]+)*$/) as HttpsUrl;
}

/** A path part or name: no `.` or `..` alone, and nothing a shell or a path would read specially. */
const namePattern = /^(?!\.{1,2}$)[A-Za-z0-9._@+-]+$/;
const versionPattern = /^[0-9A-Za-z.+-]+$/;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const npmNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function fields(value: unknown, field: string, keys: readonly string[], partial = false): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field}: expected an object`);
  const record = value as Record<string, unknown>;
  const missing = keys.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) throw new Error(`${field}: missing ${missing.join(", ")}`);
  const unknown = partial ? [] : Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${field}: unknown ${unknown.join(", ")}`);
  return record;
}

function list(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field}: expected an array`);
  return value;
}

function matching(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${field}: ${JSON.stringify(value)} does not match ${pattern}`);
  return value;
}

function unique(values: readonly string[], field: string, what: string): void {
  const repeated = values.find((value, i) => values.indexOf(value) !== i);
  if (repeated !== undefined) throw new Error(`${field}: two entries with ${what} ${repeated}`);
}

function sorted<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
