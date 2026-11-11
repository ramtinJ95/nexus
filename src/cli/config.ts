import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { readJson } from "../node-base/json-file.ts";
import { parse } from "../parse.ts";
import { call, CliError, type Endpoint, type HostPort } from "./transport.ts";
import { type Io, type Note, type Values, type Versions, str } from "./kit.ts";
import { version } from "../version.ts";
import { ports } from "../node-base/node-layout.ts";

/**
 * The oldest control plane this CLI reads, raised when the CLI starts relying on something newer. 0.53.0 is the first
 * that reports its version, so one that reports none is older.
 */
export const minControlVersion = "0.86.0";
/** No retry fixes a control plane older than `minControlVersion`. */
class OutdatedControl extends CliError {}
export const transient = (err: CliError): err is CliError & { kind: "unreachable" | "failed" } => (err.kind === "unreachable" || err.kind === "failed") && !(err instanceof OutdatedControl);
export const controlPorts = [`https://{host}:${ports.dashboard}`, `http://{host}:${ports.control}`];

/**
 * `$XDG_CONFIG_HOME/nexus/cli.json`, or under `~/.config` when that is unset or not absolute. A file at the
 * `~/.config` path, where every CLI before 0.80.0 kept it, stays the one read and written until the other exists.
 */
export function configFile(env: Io["env"] = process.env): string {
  const home = join(env.HOME || homedir(), ".config");
  const xdg = env.XDG_CONFIG_HOME;
  const file = join(xdg !== undefined && isAbsolute(xdg) ? xdg : home, "nexus", "cli.json");
  const before = join(home, "nexus", "cli.json");
  return existsSync(file) || !existsSync(before) ? file : before;
}

const configSchema = z.strictObject({ url: z.string().optional(), socks: z.string().optional() });

export async function readConfig(file: string): Promise<Config> {
  let value: unknown;
  try {
    value = await readJson(file, {});
  } catch (err) {
    throw new CliError("invalid", err instanceof SyntaxError ? `${file} is not JSON: ${err.message}` : `cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    return parse(configSchema, value, "config");
  } catch (err) {
    throw new CliError("invalid", `${file} is not a CLI config: ${(err as Error).message}`);
  }
}

type Config = z.infer<typeof configSchema>;
const fromEnv = (env: Io["env"], name: string) => env[name] || undefined;

export async function settings(v: Values, env: Io["env"]): Promise<Endpoint> {
  const config = await readConfig(configFile(env));
  const url = str(v, "url") ?? fromEnv(env, "NEXUS_URL") ?? config.url;
  if (url === undefined) throw new CliError("invalid", "no control plane is set. Run nexus connect <host> with its tailnet name, or give --url or NEXUS_URL");
  return { url: controlUrl(url), socks: socksOf(v, config, env) };
}

const versionParts = (v: unknown) => typeof v === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number) ?? null : null;

function atLeast(parts: readonly number[], min: readonly number[]): boolean {
  const i = parts.findIndex((n, j) => n !== min[j]);
  return i === -1 || parts[i]! > min[i]!;
}

export function versionsOf(health: unknown): Versions {
  const reported = (health as { version?: unknown } | null)?.version;
  return { cli: version, control: typeof reported === "string" ? reported : null };
}

export const versionsText = (v: Versions) => `This CLI runs Nexus ${v.cli}, and the control plane ${v.control ?? "reports no version"}.`;

export function outdated(url: URL, v: Versions): OutdatedControl | null {
  const parts = versionParts(v.control);
  if (parts !== null && atLeast(parts, versionParts(minControlVersion)!)) return null;
  return new OutdatedControl("failed", `the control plane at ${url.origin} runs Nexus ${v.control ?? `older than ${minControlVersion}`}, and this CLI needs ${minControlVersion} or later. Upgrade it, as deploy/README.md describes`);
}

/**
 * What a person at a terminal should do about the skew, if anything: pull the CLI up to a newer control plane, or
 * upgrade one too old, which `deploy`, `release`, `doctor` and `connect` still run against.
 */
export function skewNote(url: URL, v: Versions): string | undefined {
  const parts = versionParts(v.control);
  if (parts !== null && !atLeast(versionParts(v.cli)!, parts)) return `nexus: the control plane runs Nexus ${v.control}, newer than this CLI's ${v.cli}. Run git pull in the nexus checkout, then deploy/mac/install`;
  const old = outdated(url, v);
  return old === null ? undefined : `nexus: ${old.message}. Until then, only deploy, release, doctor and connect run against it`;
}

/** The health read before a command's first request. A control plane too old fails it unless `anyVersion` is set. */
export async function checked(endpoint: Endpoint, anyVersion: boolean, note: Note): Promise<{ endpoint: Endpoint; versions: Versions }> {
  const versions = versionsOf(await call(endpoint, "GET", "/v1/health"));
  const old = outdated(endpoint.url, versions);
  if (old !== null && !anyVersion) throw old;
  const line = skewNote(endpoint.url, versions);
  if (line !== undefined) note(line);
  return { endpoint, versions };
}

export function socksOf(v: Values, config: Config, env: Io["env"]): HostPort | null {
  const socks = str(v, "socks") ?? fromEnv(env, "NEXUS_SOCKS") ?? config.socks;
  return socks === undefined || socks === "none" ? null : hostPort(socks);
}

export function controlUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("invalid", `the control plane URL ${url} is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new CliError("invalid", `the control plane URL ${url} must be http:// or https://`);
  return parsed;
}

function hostPort(value: string): HostPort {
  const m = /^(.+):(\d+)$/.exec(value);
  if (m === null || Number(m[2]) > 65535) throw new CliError("invalid", `the SOCKS proxy ${value} must be HOST:PORT or none`);
  return { host: m[1]!, port: Number(m[2]) };
}
