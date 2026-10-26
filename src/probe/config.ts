/**
 * The probe's node-local inputs: its config file (/etc/nexus/probe.json), its secret file
 * (/etc/nexus/secrets.env) and its tailnet name. Both are parsed strictly here, at the boundary, so a typo fails the start
 * instead of surfacing as a refused caller or a missing secret on the first job.
 */
import { open, readFile } from "node:fs/promises";
import { BlockList, isIPv6 } from "node:net";
import { basename, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type { SecretSource } from "../backend.ts";
import type { ImageId } from "../images.ts";
import { probePort, type NodeName, type ProbeAuthConfig, type TailnetNodeId } from "../protocol.ts";

const absolutePath = z.string().refine(isAbsolute, "must be an absolute path");
const nodeName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase tailnet machine name").transform((v) => v as NodeName);
const tailnetNodeId = z.string().regex(/^n[A-Za-z0-9]+$/, "must be a Tailscale stable node ID, such as nAbCdEf1CNTRL (tailscale status --json)").transform((v) => v as TailnetNodeId);
/** Tailscale's address ranges. BlockList compares parsed addresses, so every spelling of an address matches. */
const tailnet = new BlockList();
tailnet.addSubnet("100.64.0.0", 10, "ipv4");
tailnet.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

const imageId = z.custom<ImageId>((v) => typeof v === "string" && /^img-[0-9a-f]{12}$/.test(v), "must be an image ID, such as img-000000000000");

/**
 * Before the artifact store, a pylon-vm backend named each image's directory in `images`, and each was
 * <store>/<image ID>. A config in that form is read as `artifacts`, the store its images share, so a deployed
 * probe.json keeps working. One whose images are anywhere else is refused with what to write instead.
 */
function imagesAsStore(backend: unknown, ctx: z.RefinementCtx): unknown {
  if (typeof backend !== "object" || backend === null || !("images" in backend) || "artifacts" in backend || (backend as { kind?: unknown }).kind !== "pylon-vm") return backend;
  const { images, ...rest } = backend as { images: unknown };
  const dirs = typeof images === "object" && images !== null ? Object.entries(images) : [];
  const stores = new Set(dirs.map(([id, dir]) => typeof dir === "string" && isAbsolute(dir) && basename(dir) === id ? dirname(dir) : ""));
  if (stores.size !== 1 || stores.has("")) {
    ctx.addIssue({ code: "custom", message: `backend.images is the form from before the artifact store. Replace it with "artifacts": the directory that holds each image as <artifacts>/<image ID>` });
    return z.NEVER;
  }
  return { ...rest, artifacts: [...stores][0] };
}

const configSchema = z.strictObject({
  node: nodeName,
  listen: z.strictObject({
    host: z.union([z.ipv4(), z.ipv6()]).refine((h) => tailnet.check(h, isIPv6(h) ? "ipv6" : "ipv4"), "must be this node's tailnet address, in 100.64.0.0/10 or fd7a:115c:a1e0::/48"),
    port: z.int().min(1).max(65535).default(probePort),
  }),
  auth: z.strictObject({ controlPlane: tailnetNodeId, peers: z.array(tailnetNodeId) }) satisfies z.ZodType<ProbeAuthConfig>,
  backend: z.preprocess(imagesAsStore, z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("pylon-vm"),
      stateRoot: absolutePath,
      /** The artifact store of images and templates, at the same path on every node (see ArtifactStore). */
      artifacts: absolutePath,
      /** Omitted: pylons can clone only over HTTPS. The key file is readable by the probe's user only. */
      gitSsh: z.strictObject({ privateKeyFile: absolutePath, knownHostsFile: absolutePath }).optional(),
    }),
    /** Local development only: Docker containers stand in for pylon VMs. Without `artifacts` it builds and holds no templates. */
    z.strictObject({ kind: z.literal("docker"), images: z.record(imageId, z.string()), labels: z.record(z.string(), z.string()).default({}), artifacts: absolutePath.optional() }),
  ])),
  secretsFile: absolutePath,
  /** Omitted: the probe publishes no previews, and a spawn that assigns one fails. */
  previews: z.strictObject({
    /** The gateway's loopback port. Keep it fixed: the serve entries that proxy to it are how the probe knows its own. */
    gatewayPort: z.int().min(1).max(65535),
    /** In the probe's state directory, so paused pylons keep their routes across restarts. */
    routesFile: absolutePath.default("/var/lib/nexus/preview-routes.json"),
  }).optional(),
});

export type ProbeConfig = z.infer<typeof configSchema>;

export function parseProbeConfig(text: string): ProbeConfig {
  const result = configSchema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error(z.prettifyError(result.error));
  return result.data;
}

export async function readProbeConfig(path: string): Promise<ProbeConfig> {
  const text = await readFile(path, "utf8");
  try {
    return parseProbeConfig(text);
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

/**
 * `NAME=value` lines, blank lines and `#` comments. Values are taken verbatim to the end of the line, so
 * quoting is refused rather than guessed at. Errors name the line, never the value.
 */
export function parseSecretsEnv(text: string): SecretSource {
  const values = new Map<string, string>();
  text.split(/\r?\n/).forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (/^\s*(#|$)/.test(line)) return;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) throw new Error(`${at} is not NAME=value`);
    const [, name, value] = match as unknown as [string, string, string];
    if (values.has(name)) throw new Error(`${at} sets ${name} a second time`);
    if (value === "") throw new Error(`${at} gives ${name} no value`);
    if (/^(["']).*\1$/.test(value)) throw new Error(`${at} quotes the value of ${name}. Values are taken verbatim, so remove the quotes`);
    values.set(name, value);
  });
  return { value: (name) => values.get(name), names: () => [...values.keys()] };
}

/** Refuses a file that every user on the node can read or write. The probe user reads it through its group. */
export async function readSecretsFile(path: string): Promise<SecretSource> {
  // One descriptor for the check and the read, so the file cannot be swapped between them.
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if ((stat.mode & 0o007) !== 0) {
      throw new Error(`${path} has mode ${(stat.mode & 0o777).toString(8)}, so every user on this node can reach it. Run chmod o-rwx ${path}`);
    }
    try {
      return parseSecretsEnv(await file.readFile("utf8"));
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}`);
    }
  } finally {
    await file.close();
  }
}

const statusSchema = z.object({ Self: z.object({ DNSName: z.string() }) });

/**
 * The node's MagicDNS name from `tailscale status --json`, such as infra-testbench.example.ts.net. Previews are
 * served under it, so a node without one cannot publish them.
 */
export function parseSelfDnsName(statusJson: string): string {
  const result = statusSchema.safeParse(JSON.parse(statusJson));
  if (!result.success) throw new Error(`tailscale status --json has no Self.DNSName:\n${z.prettifyError(result.error)}`);
  const name = result.data.Self.DNSName.replace(/\.$/, "");
  if (name === "") throw new Error("tailscale reports no MagicDNS name for this node, so previews have no host to be served under. Turn on MagicDNS for the tailnet");
  return name;
}
