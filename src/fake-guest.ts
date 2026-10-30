/**
 * Test double for Guest. It records every exec argv and every written file, and answers each exec from a
 * script. The `herdr*` helpers print what Herdr 0.9.5's CLI prints: one JSON line, `{ id, result }` with
 * exit 0, or `{ id, error }` with exit 1.
 */
import type { Guest } from "./backend.ts";
import type { OpenPipe } from "./pipe.ts";
import { processStream } from "./process-stream.ts";
import type { OverlayFile } from "./spawn.ts";
import type { SessionRecord } from "./sessions.ts";

export type ExecReply = { exitCode: number | null; output: string; truncated?: boolean };

export interface FakeGuest extends Guest {
  readonly execs: (readonly string[])[];
  readonly written: OverlayFile[];
  /** The Herdr subcommands run so far, such as "workspace create", in order. */
  herdrCalls(): string[];
}

/** A Herdr call read by name, as Herdr parses it, wherever Nexus puts each word. */
export interface HerdrArgs {
  /** The subcommand, such as "agent start". */
  command: string;
  /** Its other operands in order, such as the pane `pane close` closes. */
  operands: string[];
  /** Each `--flag value`, with "" for a flag that takes none, such as `--no-focus`. `--session` is one of them. */
  flags: Record<string, string>;
  /** The argv after `--`: the launched agent's own, asserted exactly and in order. */
  rest: string[];
}

const valuelessFlags = new Set(["--no-focus"]);

/** Reads Herdr's arguments: those after `herdr`, or after `herdr --session nexus` as fakeGuest's script gets them. */
export function herdrArgs(args: readonly string[]): HerdrArgs {
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  const words: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < end; i++) {
    const word = args[i]!;
    if (!word.startsWith("--")) words.push(word);
    else flags[word] = valuelessFlags.has(word) ? "" : args[++i]!;
  }
  return { command: words.slice(0, 2).join(" "), operands: words.slice(2), flags, rest: args.slice(end + 1) };
}

/** Reads a guest exec as the Herdr call it makes, plain or claimed first as sessions.ts `herdr()` makes it, or null for any other exec. */
export function herdrCall(argv: readonly string[]): (HerdrArgs & { marker: string | null; args: readonly string[] }) | null {
  const marker = argv[0] === "sh" && argv[1] === "-c" ? argv[3] ?? null : null;
  const words = marker === null ? argv : argv.slice(4);
  if (words[0] !== "herdr") return null;
  const call = herdrArgs(words.slice(1));
  if (call.flags["--session"] === undefined) return null;
  const session = words.indexOf("--session") - 1;
  return { ...call, marker, args: words.slice(1).filter((_, i) => i !== session && i !== session + 1) };
}

/** `script` gets Herdr's arguments without `--session nexus` for Herdr calls, and the whole argv for anything else. */
export function fakeGuest(script: (argv: readonly string[], herdr: boolean) => ExecReply): FakeGuest {
  const execs: (readonly string[])[] = [];
  const written: OverlayFile[] = [];
  const plainHerdr = (argv: readonly string[]) => { const call = herdrCall(argv); return call?.marker === null ? call : null; };
  return {
    execs,
    written,
    herdrCalls: () => execs.flatMap((argv) => plainHerdr(argv)?.command ?? []),
    async exec(argv) {
      execs.push(argv);
      const call = plainHerdr(argv);
      const reply = call === null ? script(argv, false) : script(call.args, true);
      return { truncated: false, ...reply };
    },
    async writeFiles(files) { written.push(...files); },
    ...unusedGuest,
  };
}

/** The Guest calls a session test never makes. */
export const unusedGuest: Omit<Guest, "exec" | "writeFiles"> = {
  stream: () => Promise.reject(new Error("unused")),
  services: () => Promise.reject(new Error("unused")),
  startService: () => Promise.reject(new Error("unused")),
  linkPort: () => Promise.reject(new Error("unused")),
  unlinkPort: () => Promise.reject(new Error("unused")),
  previewOrigin: () => { throw new Error("unused"); },
};

/** Each pipe runs its argv on this machine, as a pylon would over its raw pipe. */
export function localPipes(): { open: OpenPipe; requests: (readonly string[])[]; stderr: string[] } {
  const requests: (readonly string[])[] = [];
  const stderr: string[] = [];
  return {
    requests, stderr,
    open: async (argv) => {
      requests.push(argv);
      return processStream(argv[0]!, argv.slice(1), (text) => { stderr.push(text); });
    },
  };
}

/** The read of a sessions file that records `records` and no failed sessions. */
export function sessionsFileReply(records: readonly SessionRecord[]): ExecReply {
  return { exitCode: 0, output: JSON.stringify({ version: 1, recordedAt: "2027-01-01T00:00:00Z", sessions: records, failed: [] }) };
}

export function herdrOk(result: unknown): ExecReply {
  return { exitCode: 0, output: JSON.stringify({ id: "cli:test", result }) + "\n" };
}

export function herdrError(code: string, message = code): ExecReply {
  return { exitCode: 1, output: JSON.stringify({ error: { code, message }, id: "cli:test" }) + "\n" };
}

/** A Herdr PaneInfo with the fields Nexus reads. */
export function herdrPane(paneId: string, workspaceId: string, agent: string | null, status: string, session: { kind: "id" | "path"; value: string } | null = null, cwd = "/home/user/workspace/repo") {
  return {
    pane_id: paneId, workspace_id: workspaceId, tab_id: `${workspaceId}:t1`, terminal_id: `term-${paneId}`, focused: false, revision: 1,
    agent, agent_status: status, cwd, foreground_cwd: cwd,
    agent_session: session === null || agent === null ? null : { agent, kind: session.kind, source: `herdr:${agent}`, value: session.value },
  };
}

export function herdrSnapshot(workspaces: readonly { id: string; label: string }[], panes: readonly ReturnType<typeof herdrPane>[]) {
  return {
    type: "session_snapshot",
    snapshot: {
      version: "0.9.5", protocol: 22, layouts: [], agents: [], tabs: [], panes,
      workspaces: workspaces.map((w, i) => ({ workspace_id: w.id, label: w.label, number: i + 1, focused: false, pane_count: 1, tab_count: 1, agent_status: "idle", active_tab_id: `${w.id}:t1` })),
    },
  };
}
