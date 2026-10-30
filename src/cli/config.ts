/** Where the CLI finds the control plane: its flags, the environment and the config file, and the version check. */
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readJson } from "../json-file.ts";
import { parse } from "../parse.ts";
import { call, CliError, type Endpoint, type HostPort } from "./transport.ts";
import { type Values, str } from "./kit.ts";

/**
 * The oldest control plane this CLI reads, raised when the CLI starts relying on something newer. 0.53.0 is the first
 * that reports its version, so one that reports none is older.
 */
const minControlVersion = "0.53.0";
/** A control plane older than `minControlVersion`, which no retry fixes. */
class OutdatedControl extends CliError {}
/** What a watch or a follow reports and retries through: a control plane unreachable or failing, though not one too old. */
export const transient = (err: CliError): err is CliError & { kind: "unreachable" | "failed" } => (err.kind === "unreachable" || err.kind === "failed") && !(err instanceof OutdatedControl);
/** Where `connect` looks for the API on a host: the dashboard's HTTPS port, then the plain HTTP port. */
export const controlPorts = ["https://{host}:7443", "http://{host}:7470"];
export const configFile = () => join(homedir(), ".config", "nexus", "cli.json");

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
const env = (name: string) => process.env[name] || undefined;

/** Each setting from its flag, then the environment, then the config file. No URL is set until `connect` saves one. */
export async function settings(v: Values): Promise<Endpoint> {
  const config = await readConfig(configFile());
  const url = str(v, "url") ?? env("NEXUS_URL") ?? config.url;
  if (url === undefined) throw new CliError("invalid", "no control plane is set. Run nexus connect <host> with its tailnet name, or give --url or NEXUS_URL");
  return { url: controlUrl(url), socks: socksOf(v, config) };
}

const versionParts = (v: unknown) => typeof v === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number) ?? null : null;

/** Whether a version is `min` or later, by major, minor and patch. */
function atLeast(parts: readonly number[], min: readonly number[]): boolean {
  const i = parts.findIndex((n, j) => n !== min[j]);
  return i === -1 || parts[i]! > min[i]!;
}

/** Refuses a control plane older than this CLI reads, by the version its health reply reports. */
export function checkVersion(url: URL, health: unknown): void {
  const reported = (health as { version?: unknown } | null)?.version;
  const parts = versionParts(reported);
  if (parts !== null && atLeast(parts, versionParts(minControlVersion)!)) return;
  throw new OutdatedControl("failed", `the control plane at ${url.origin} runs Nexus ${typeof reported === "string" ? reported : `older than ${minControlVersion}`}, and this CLI needs ${minControlVersion} or later. Upgrade it, as deploy/README.md describes`);
}

export async function checked(endpoint: Endpoint): Promise<Endpoint> {
  checkVersion(endpoint.url, await call(endpoint, "GET", "/v1/health"));
  return endpoint;
}

export function socksOf(v: Values, config: Config): HostPort | null {
  const socks = str(v, "socks") ?? env("NEXUS_SOCKS") ?? config.socks;
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
