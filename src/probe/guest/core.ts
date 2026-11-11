/**
 * Herdr Core's API inside a pylon, one guest exec as `user` per call: a JSON-RPC request piped through
 * `herdr-core connect` to the core the pylon's boot started. Every Core command, a read included, starts a core when
 * none runs (spikes/herdr-core/README.md, core-autostart), so the exec first checks that one runs and exits
 * `noCoreExit` without one, or `coreLostExit` when the programs of a core that crashed still run without it. A read
 * therefore never starts a core.
 */
import { z } from "zod";
import type { Guest } from "../../backends/backend.ts";
import { nonEmpty, parse, parseJson } from "../../parse.ts";
import { callTimeoutMs, coreHeld, coreRunning, execOutputMaxBytes } from "../../guest-contract.ts";
import { home } from "../../../images/pylon/nexus-contract.ts";

export const noCoreExit = 69;
export const coreLostExit = 70;
/** How much of a terminal's screen a read keeps, and of each of its arguments a terminal keeps. */
export const screenChars = 8192;
const argChars = 256;

/**
 * Keeps only what Nexus reads of each terminal in the reply. A terminal comes with its whole screen, and its arguments
 * hold a prompted launch's prompt, twice with its foreground's, so a list of a few could pass the guest's exec output
 * cap. No argument Nexus reads, a session ID, a model or a program's name, comes near `argChars`.
 */
const slimReply = `
let text = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => { text += chunk; }).on("end", () => {
  const lines = text.trimEnd().split("\\n");
  const at = lines.findLastIndex((line) => line.startsWith("{"));
  let reply;
  try { reply = JSON.parse(lines[at]); } catch { process.stdout.write(text); return; }
  const cut = (args) => Array.isArray(args) ? args.map((arg) => typeof arg === "string" ? arg.slice(0, ${argChars}) : arg) : args;
  const slim = (t) => ({
    address: t.address, name: t.name, state: t.state, labels: t.labels, argv: cut(t.argv), cwd: t.cwd, parent: t.parent,
    foreground: t.foreground && { argv: cut(t.foreground.argv), cwd: t.foreground.cwd, name: t.foreground.name },
    status: t.status && { state: t.status.state, app: t.status.app }, exit_code: t.exit_code,
  });
  const result = reply && reply.result;
  if (result && Array.isArray(result.terminals)) result.terminals = result.terminals.map(slim);
  else if (result && typeof result.address === "string" && "screen" in result) reply.result = slim(result);
  else if (result && typeof result.text === "string") result.text = result.text.trimEnd().slice(-${screenChars});
  process.stdout.write([...lines.slice(0, at), JSON.stringify(reply)].join("\\n") + "\\n");
});`;

/** `$1` is the request and `$2` slimReply. */
export const coreCall = `${coreRunning} || { ${coreHeld} && exit ${coreLostExit}; exit ${noCoreExit}; }; printf '%s\\n' "$1" | herdr-core connect | exec node -e "$2"`;

/**
 * A Core error. `kind` is Core's, such as `not_found`, `name_taken`, `blocked`, `unavailable`, `finished` or `live`;
 * or `no_core` when no core runs; or `core_lost` when none runs but the programs of one that crashed do, so what
 * runs is unknown until a core takes them back.
 */
export class CoreError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

const terminalSchema = z.object({
  address: nonEmpty,
  name: z.string().nullish().transform((name) => name ?? null),
  state: z.enum(["live", "finished"]),
  labels: z.record(z.string(), z.string()),
  argv: z.array(z.string()),
  cwd: z.string(),
  /** The terminal that started it, which it belongs to, such as a shepherdr reviewer's Claude. */
  parent: z.string().nullish().transform((parent) => parent ?? null),
  /** What its program runs now: the process group that holds its terminal. */
  foreground: z.object({ argv: z.array(z.string()), cwd: z.string(), name: z.string() }).nullish().transform((f) => f ?? null),
  /** The program's own word for what it does, from its OSC 7501 reports, or null if it never said or has exited. */
  status: z.object({ state: z.string(), app: z.string().nullish() }).nullish().transform((s) => s ?? null),
  exit_code: z.number().nullish(),
});
export type Terminal = z.infer<typeof terminalSchema>;

const results = {
  "terminal.list": z.object({ terminals: z.array(terminalSchema) }),
  "terminal.get": terminalSchema,
  "terminal.run": terminalSchema,
  "terminal.read": z.object({ text: z.string() }),
  /** `status` is the program's word when the text went in. */
  "terminal.send": z.object({ status: z.string().nullish(), turn: z.number() }),
  "terminal.keys": z.object({}),
  "terminal.kill": terminalSchema,
  "terminal.rm": z.object({ removed: nonEmpty }),
  /** `reason` is `status` when it stopped working, `exit` when its program ended, and `timeout` at a check-in. */
  "terminal.wait": z.object({ ended: z.boolean(), reason: z.string(), status: z.string().nullish(), exit_code: z.number().nullish() }),
} satisfies Record<string, z.ZodType>;

/** The parameters Nexus passes each method. A terminal is its address, or its name. */
interface Params {
  "terminal.list": { all?: true };
  "terminal.get": { terminal: string };
  "terminal.run": { argv: readonly string[]; cwd: string; labels: Readonly<Record<string, string>>; no_parent: true; name?: string; keep?: true };
  "terminal.read": { terminal: string };
  "terminal.send": { terminal: string; text: string };
  "terminal.keys": { terminal: string; keys: readonly string[] };
  "terminal.kill": { terminal: string };
  "terminal.rm": { terminal: string };
  "terminal.wait": { terminal: string; timeout: number };
}
export type CoreMethod = keyof typeof results;

const replySchema = z.object({
  id: z.literal(1),
  result: z.unknown().optional(),
  error: z.object({ message: nonEmpty, data: z.object({ kind: nonEmpty }).nullish() }).optional(),
});

/** One API call. `connect` exits 0 on an error reply too, so the reply decides. */
export async function core<M extends CoreMethod>(guest: Guest, method: M, params: Params[M], timeoutMs = callTimeoutMs): Promise<z.infer<(typeof results)[M]>> {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const { exitCode, output, truncated } = await guest.exec(["sh", "-c", coreCall, "core", request, slimReply], { cwd: home, timeoutMs });
  if (exitCode === null) throw new Error(`${method} did not finish within ${timeoutMs} ms`);
  if (exitCode === noCoreExit) throw new CoreError("no_core", `${method}: no Herdr Core runs`);
  if (exitCode === coreLostExit) throw new CoreError("core_lost", `${method}: no Herdr Core runs, but the programs of one that crashed still do`);
  if (truncated) throw new Error(`${method}'s reply passed the guest's ${execOutputMaxBytes}-byte output limit`);
  const line = output.trimEnd().split("\n").findLast((l) => l.startsWith("{"));
  if (line === undefined) throw new Error(`${method} exited ${exitCode} without a JSON reply: ${output.slice(-500)}`);
  const reply = parseJson(replySchema, line, `${method} reply`);
  if (reply.error !== undefined) throw new CoreError(reply.error.data?.kind ?? "unknown", `${method}: ${reply.error.message}`);
  if (exitCode !== 0) throw new Error(`${method} exited ${exitCode}: ${output.slice(-500)}`);
  return parse<unknown>(results[method], reply.result, `${method} result`) as z.infer<(typeof results)[M]>;
}

/** For a read that answers `value` when no core runs, and rejects on any other failure. */
export function noCore<T>(value: T): (err: unknown) => T {
  return (err) => {
    if (err instanceof CoreError && err.kind === "no_core") return value;
    throw err;
  };
}
