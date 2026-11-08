/**
 * The fields of control.json and probe.json that the deployer and the installers read. They run before npm ci, so they
 * have neither zod nor the configs' schemas in src/control/main.ts and src/probe/config.ts, and read only these. A field
 * is undefined where the file or a step of its path is missing, and the reader throws, naming both, when it holds
 * another kind of value.
 */

export interface Listen { host: string; port: number }

export interface ControlFields {
  db: string | undefined;
  callers: readonly string[] | undefined;
  harnessCredentials: string | undefined;
  githubTokenFile: string | undefined;
}

export interface ProbeFields {
  node: string | undefined;
  secretsFile: string | undefined;
  gitKeyFile: string | undefined;
}

type Kind = "string" | "number" | "strings";

function field(config: unknown, file: string, path: string, kind: Kind): unknown {
  let value = config;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  if (value === undefined) return undefined;
  if (kind === "strings" ? Array.isArray(value) && value.every((item) => typeof item === "string") : typeof value === kind) return value;
  throw new Error(`${file}'s ${path} is not ${kind === "strings" ? "a list of strings" : `a ${kind}`}`);
}

const text = (config: unknown, file: string, path: string) => field(config, file, path, "string") as string | undefined;

export function controlFields(config: unknown, file: string): ControlFields {
  return {
    db: text(config, file, "db"),
    callers: field(config, file, "callers", "strings") as string[] | undefined,
    harnessCredentials: text(config, file, "harness.credentials"),
    githubTokenFile: text(config, file, "github.tokenFile"),
  };
}

export function probeFields(config: unknown, file: string): ProbeFields {
  return {
    node: text(config, file, "node"),
    secretsFile: text(config, file, "secretsFile"),
    gitKeyFile: text(config, file, "backend.gitSsh.privateKeyFile"),
  };
}

/** Where control.json's or probe.json's service listens, which both require. */
export function listenAddress(config: unknown, file: string): Listen {
  const host = text(config, file, "listen.host");
  const port = field(config, file, "listen.port", "number") as number | undefined;
  if (host === undefined || port === undefined) throw new Error(`${file} has no listen.${host === undefined ? "host" : "port"}`);
  return { host, port };
}
