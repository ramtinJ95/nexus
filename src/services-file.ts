/**
 * The repo owns how to build and run the project: .nexus/setup, .nexus/resume, .nexus/services.yaml.
 * Nexus has its own directory, so no other tool that auto-runs `.agents/setup` (pi-sandbox runs it as
 * root) fights over the same files.
 */
import { isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";

/**
 * Nexus's own schema. It starts from pi-sandbox's `services` schema (src/contracts.ts serviceSchema),
 * so the pi-sandbox-derived backend needs only a path rewrite. The word is "preview" in the file, the
 * records, the CLI and the dashboard.
 */
export interface ServicesFile {
  services: Record<ServiceName, ServiceDecl>;
}
export type ServiceName = string; // /^[a-z0-9][a-z0-9-]{0,31}$/
/** The name a port linked with `nexus preview <port>` is reported and previewed under. */
export const linkedName = (port: number): ServiceName => `port-${port}`;
/** The port of a service named as linkedName names one, or null for any other name. */
export function linkedPort(service: ServiceName): number | null {
  const m = /^port-([1-9]\d{0,4})$/.exec(service);
  return m === null ? null : Number(m[1]);
}
/**
 * The ports the pylon's loopback relay (src/pylon-vm/relay.ts) listens on, one per routed port. They are below 1024,
 * so the agent's apps, which run as `user`, can never hold one.
 */
export const relayPorts = { first: 700, last: 799 } as const;
/**
 * Nexus's own listeners in every pylon: the sshd that Gondolin's enableSsh starts for streams and terminals, and the
 * relay's ports. They are never reported as listening, and never linked.
 */
export const reservedPorts: ReadonlySet<number> = new Set([22, ...Array.from({ length: relayPorts.last - relayPorts.first + 1 }, (_, i) => relayPorts.first + i)]);
/** Why a declaration may not fix a port in reservedPorts. */
export const reservedPortMessage = `is Nexus's own: sshd's 22, or the preview relay's ${relayPorts.first} to ${relayPorts.last}`;
export interface ServiceDecl {
  command: string; // foreground, run as `user` through a login shell
  cwd?: string; // relative to the repo root, default "."
  port?: number; // omitted: a sticky free port. Fixed ports must be unique
  env?: Record<string, string>; // may contain ${services.<name>.publicURL}. That service starts first and must have a preview
  health?: `/${string}` | "process"; // HTTP GET 2xx or 3xx, or the supervisor is alive. Default: TCP connect
  preview?: boolean | { url?: string; title?: string; description?: string };
  previews?: readonly (PreviewLink | { folder: string; links: readonly PreviewLink[] })[];
  platforms?: readonly ("linux" | "darwin")[];
  timeoutMs?: number; // readiness deadline, default 30000
}
export interface PreviewLink { url: string; title: string; description?: string }

/** Names `env` may not set. PUBLIC_URL is the https tailnet URL, because the guest sees x-forwarded-proto: http (S4). */
export const managedEnv = ["PORT", "PUBLIC_URL"] as const; // plus every NEXUS_* name, such as NEXUS_THREAD_ID

/**
 * The boundary for .nexus/services.yaml: callers trust the result. Throws on a file over 1 MiB, duplicate
 * keys, a key that is not a string (`1:` and `"1":` would collapse), more than 20 alias expansions, any field
 * or value the schema does not allow, a duplicate fixed port, and an env value whose `${services.`
 * reference is malformed, names a service without a preview, or closes a cycle.
 * The pylon's supervisor (src/pylon-vm/services.ts) reads the file with it too, so every backend accepts the
 * same files. Omitted fields stay omitted: the defaults in ServiceDecl are applied where the service runs.
 */
export function parseServicesFile(yamlText: string): ServicesFile {
  if (Buffer.byteLength(yamlText) > maxServicesFileBytes) throw new Error(`invalid .nexus/services.yaml: larger than ${maxServicesFileBytes} bytes`);
  const document = parseDocument(yamlText, { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`invalid .nexus/services.yaml: ${document.errors.map((e) => e.message).join("; ")}`);
  visit(document, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw new Error(`invalid .nexus/services.yaml: key ${String(pair.key)} is not a string`);
    },
  });
  const parsed = servicesFileSchema.safeParse(document.toJS({ maxAliasCount: 20 }));
  if (!parsed.success) throw new Error(`invalid .nexus/services.yaml:\n${z.prettifyError(parsed.error)}`);
  // Zod types an optional field as `T | undefined`, but it never adds a key the file lacks. ParsesTo below checks the rest.
  return parsed.data as ServicesFile;
}

const maxServicesFileBytes = 1_048_576;
export const serviceName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const isManaged = (name: string): boolean => (managedEnv as readonly string[]).includes(name) || name.startsWith("NEXUS_");
// The name checks are on the record, not the key schema, because Zod reports a failed key only as "Invalid key in record".
const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).superRefine((vars, ctx) => {
  for (const name of Object.keys(vars)) {
    if (isManaged(name)) ctx.addIssue({ code: "custom", path: [name], message: `${name} is managed by Nexus` });
    // The backend refuses Amp's thread variable.
    if (name === "AMP_THREAD_ID") ctx.addIssue({ code: "custom", path: [name], message: "AMP_THREAD_ID is not available" });
  }
});
/** The backend refuses Amp's identity placeholder in any preview url, title or description. */
export const previewText = z.string().refine((s) => !s.includes("$AMP_USER_EMAIL"), "$AMP_USER_EMAIL is not available");
/** A path on the service's own origin, or an absolute http(s) URL, as pi-sandbox allows. */
const previewUrl = previewText.refine((s) => {
  if (s.startsWith("/")) return !s.startsWith("//");
  return URL.canParse(s) && ["http:", "https:"].includes(new URL(s).protocol);
}, "must be a path starting with / or an http(s) URL");
const previewLink = z.strictObject({ url: previewUrl, title: previewText.min(1), description: previewText.optional() });
/**
 * True when `Schema` parses to exactly `T`, field for field. Zod types an omitted field as `T | undefined`, which
 * exactOptionalPropertyTypes tells apart from an omitted key, so the check drops that `undefined` first.
 */
export type ParsesTo<Schema extends z.ZodType, T> =
  (<U>() => U extends Declared<z.output<Schema>> ? 1 : 2) extends (<U>() => U extends T ? 1 : 2) ? true : false;
type Declared<T> = T extends readonly (infer E)[] ? readonly Declared<E>[] : T extends object ? { [K in keyof T]: Declared<Exclude<T[K], undefined>> } : T;
/** One service as the services file declares it. The in-pylon API parses `service-start` with it too. */
export const serviceDecl = z.strictObject({
  command: z.string().min(1),
  cwd: z.string().refine((s) => !s.includes("\0") && !s.startsWith("/") && !s.split("/").includes(".."), "must be a path inside the repo").optional(),
  port: z.int().min(1).max(65535).refine((port) => !reservedPorts.has(port), reservedPortMessage).optional(),
  env: env.optional(),
  health: z.union([z.templateLiteral(["/", z.string()]), z.literal("process")]).optional(),
  preview: z.union([
    z.boolean(),
    z.strictObject({ url: previewUrl.optional(), title: previewText.min(1).optional(), description: previewText.optional() }),
  ]).optional(),
  previews: z.array(z.union([previewLink, z.strictObject({ folder: z.string().min(1), links: z.array(previewLink).min(1) })]))
    .refine((links) => {
      const folders = links.flatMap((link) => "folder" in link ? [link.folder] : []);
      return new Set(folders).size === folders.length;
    }, "folder names must be unique")
    .optional(),
  platforms: z.array(z.enum(["linux", "darwin"])).min(1).optional(),
  timeoutMs: z.int().min(100).max(120_000).optional(),
});
true satisfies ParsesTo<typeof serviceDecl, ServiceDecl> & ParsesTo<typeof previewLink, PreviewLink>;

/** Matches every `${services.`. The group is set only for a whole reference, so a typo or a missing `}` cannot pass as a literal. */
export const serviceReference = /\$\{services\.(?:([a-z0-9][a-z0-9-]{0,31})\.publicURL\})?/g;
export const wantsPreview = (decl: { preview?: unknown; previews?: readonly unknown[] | undefined }): boolean => Boolean(decl.preview) || (decl.previews?.length ?? 0) > 0;
/** `env` with each `${services.<name>.publicURL}` replaced by that service's public URL. Throws while one it names has none. */
export function withPublicUrls(service: ServiceName, env: Record<string, string>, urls: Record<ServiceName, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replace(serviceReference, (whole, dependency: string | undefined) => {
    if (dependency === undefined) return whole;
    const url = urls[dependency];
    if (url === undefined) throw new Error(`Service ${service} needs the public URL of ${dependency}, which has no preview assigned yet. It starts once one is`);
    return url;
  })]));
}

const servicesFileSchema = z.strictObject({ services: z.record(serviceName, serviceDecl) }).superRefine(({ services }, ctx) => {
  const portOwner = new Map<number, string>();
  for (const [name, decl] of Object.entries(services)) {
    if (decl.port === undefined) continue;
    const owner = portOwner.get(decl.port);
    if (owner !== undefined) ctx.addIssue({ code: "custom", path: ["services", name, "port"], message: `port ${decl.port} is also fixed by ${owner}` });
    portOwner.set(decl.port, name);
  }

  const dependencies = new Map<string, string[]>();
  for (const [name, decl] of Object.entries(services)) {
    const names: string[] = [];
    for (const [key, value] of Object.entries(decl.env ?? {})) {
      for (const [whole, target] of value.matchAll(serviceReference)) {
        const path = ["services", name, "env", key];
        if (target === undefined) ctx.addIssue({ code: "custom", path, message: `${JSON.stringify(value)} has a \${services. that is not a whole \${services.<name>.publicURL} reference` });
        else if (services[target] === undefined || !wantsPreview(services[target])) ctx.addIssue({ code: "custom", path, message: `${whole} names ${target}, which is not a declared service with a preview` });
        else names.push(target);
      }
    }
    dependencies.set(name, names);
  }

  // Depth-first search. A service met again while it is still on the stack closes a cycle.
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    if (done.has(name)) return;
    const at = stack.indexOf(name);
    if (at !== -1) {
      ctx.addIssue({ code: "custom", path: ["services", name, "env"], message: `publicURL references form a cycle: ${[...stack.slice(at), name].join(" -> ")}` });
      return;
    }
    stack.push(name);
    for (const next of dependencies.get(name)!) visit(next);
    stack.pop();
    done.add(name);
  };
  for (const name of dependencies.keys()) visit(name);
});
