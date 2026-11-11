/**
 * Test double for Guest. It records every exec argv and every written file, and answers each exec from a
 * script. fakeCore answers the probe's Herdr Core calls as a core holding terminals would, and the `core*` replies
 * are one call's answer as core.ts reads it.
 */
import type { Guest } from "./backend.ts";
import type { OpenPipe } from "../pipe.ts";
import { processStream } from "../process-stream.ts";
import type { OverlayFile } from "../protocol/spawn.ts";
import type { SessionRecord } from "../probe/guest/sessions.ts";
import { coreCall, noCoreExit } from "../probe/guest/core.ts";
import { ensureCore } from "../guest-contract.ts";
import { checkoutDir } from "../../images/pylon/nexus-contract.ts";

export type ExecReply = { exitCode: number | null; output: string; truncated?: boolean };

export interface FakeGuest extends Guest {
  readonly execs: (readonly string[])[];
  readonly written: OverlayFile[];
}

export function fakeGuest(script: (argv: readonly string[]) => ExecReply): FakeGuest {
  const execs: (readonly string[])[] = [];
  const written: OverlayFile[] = [];
  return {
    execs,
    written,
    async exec(argv) {
      execs.push(argv);
      return { truncated: false, ...script(argv) };
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

/** A core call as core.ts makes it, read back as its method and params, or null for any other exec. */
export function coreRequest(argv: readonly string[]): { method: string; params: Record<string, unknown> } | null {
  if (argv[0] !== "sh" || argv[1] !== "-c" || argv[2] !== coreCall) return null;
  const { method, params } = JSON.parse(argv[4]!) as { method: string; params: Record<string, unknown> };
  return { method, params };
}

export function coreOk(result: unknown): ExecReply {
  return { exitCode: 0, output: JSON.stringify({ id: 1, jsonrpc: "2.0", result }) + "\n" };
}

export function coreError(kind: string, message = kind): ExecReply {
  return { exitCode: 0, output: JSON.stringify({ error: { code: -32000, data: { hint: "", kind }, message }, id: 1, jsonrpc: "2.0" }) + "\n" };
}

/** What the guard answers when no core runs. */
export const coreNotRunning: ExecReply = { exitCode: noCoreExit, output: "" };

export interface FakeTerminal {
  address: string;
  name: string | null;
  state: "live" | "finished";
  labels: Record<string, string>;
  argv: readonly string[];
  cwd: string;
  parent: string | null;
  keep: boolean;
  foreground: { argv: readonly string[]; cwd: string; name: string } | null;
  status: { state: string; app?: string } | null;
  exitCode: number | null;
  screen: string;
  /** Each text sent to it, in order. */
  sent: string[];
  keys: (readonly string[])[];
}

export interface FakeCore {
  /** Whether a core runs. A call without one gets the guard's exit, and an ensureCore starts one. */
  running: boolean;
  readonly terminals: FakeTerminal[];
  /** Each call, in order, as its method and params. */
  readonly calls: { method: string; params: Record<string, unknown> }[];
  /** A live terminal, as one opened by hand or kept through a wake. */
  add(t: Partial<FakeTerminal>): FakeTerminal;
  /** A core stop and start: each kept terminal comes back live as a shell, at its address and with its labels, and the rest finish. */
  restart(): void;
  /** The reply to a core call or an ensureCore, or undefined for any other exec. */
  reply(argv: readonly string[]): ExecReply | undefined;
}

/** The program a Nexus launch runs, without the env and login shell it wraps it in. */
export function launchedProgram(argv: readonly string[]): readonly string[] {
  const at = argv.indexOf('exec "$0" "$@"');
  return argv[0] === "env" && at !== -1 ? argv.slice(at + 1) : argv;
}

/**
 * A core that keeps its terminals as Core does: addresses t1, t2, ... never reused, names unique among live terminals,
 * kills that finish and removes that need a finished terminal. A run's program is in its foreground at once, and an
 * agent reports idle, a shell nothing. `start` changes what a run's program does, such as exit or wait at a dialog,
 * and `answer` overrides any call's reply.
 */
export function fakeCore(options: {
  running?: boolean;
  start?: (t: FakeTerminal) => void;
  answer?: (method: string, params: Record<string, unknown>, core: FakeCore) => ExecReply | undefined;
} = {}): FakeCore {
  let next = 1;
  const terminals: FakeTerminal[] = [];
  const calls: FakeCore["calls"] = [];
  const terminal = (t: Partial<FakeTerminal>): FakeTerminal => {
    const argv = t.argv ?? ["bash", "-l"];
    const program = launchedProgram(argv);
    return {
      address: `t${next++}`, name: null, state: "live", labels: {}, cwd: checkoutDir, parent: null, keep: false, exitCode: null, screen: "", sent: [], keys: [],
      foreground: { argv: program, cwd: t.cwd ?? checkoutDir, name: program[0]!.split("/").at(-1)! }, status: null, ...t, argv,
    };
  };
  // A name finds a live terminal first, as Core's names are unique among those.
  const find = (ref: unknown) => terminals.find((t) => t.address === ref) ?? terminals.find((t) => t.name === ref && t.state === "live") ?? terminals.findLast((t) => t.name === ref);
  const view = ({ address, name, state, labels, argv, cwd, parent, foreground, status, exitCode }: FakeTerminal) =>
    ({ address, name, state, labels, argv, cwd, parent, foreground, status, exit_code: exitCode });
  const finish = (t: FakeTerminal, exitCode: number | null) => Object.assign(t, { state: "finished", foreground: null, status: null, exitCode });
  const waited = (t: FakeTerminal, ended: boolean, reason: string, status: string | null) =>
    coreOk({ children: [], ended, exit_code: t.exitCode, reason, signal: null, status, terminal: t.address, turn: 0 });
  const fake: FakeCore = {
    running: options.running ?? true,
    terminals, calls,
    add(t) {
      const added = terminal(t);
      terminals.push(added);
      return added;
    },
    restart() {
      for (const t of terminals) {
        if (t.state !== "live") continue;
        if (t.keep) Object.assign(t, { argv: ["/bin/bash"], foreground: { argv: ["-bash"], cwd: t.cwd, name: "bash" }, status: null });
        else finish(t, null);
      }
    },
    reply(argv) {
      if (argv[0] === "sh" && argv[1] === "-c" && argv[2] === ensureCore) {
        fake.running = true;
        return { exitCode: 0, output: "" };
      }
      const request = coreRequest(argv);
      if (request === null) return undefined;
      if (!fake.running) return coreNotRunning;
      const { method, params } = request;
      calls.push(request);
      const answered = options.answer?.(method, params, fake);
      if (answered !== undefined) return answered;
      const t = params.terminal === undefined ? undefined : find(params.terminal);
      if (params.terminal !== undefined && t === undefined) return coreError("not_found", `no terminal ${JSON.stringify(params.terminal)}`);
      switch (method) {
        case "terminal.list": return coreOk({ hidden_finished: 0, machines: [], terminals: terminals.filter((x) => params.all === true || x.state === "live").map(view) });
        case "terminal.get": return coreOk(view(t!));
        case "terminal.read": return coreOk({ text: t!.screen, complete: true, how: "screen" });
        case "terminal.run": {
          if (params.name != null && terminals.some((x) => x.state === "live" && x.name === params.name)) return coreError("name_taken", `a live terminal is already named ${JSON.stringify(params.name)}`);
          const run = fake.add({ argv: params.argv as string[], cwd: params.cwd as string, name: (params.name as string | undefined) ?? null, labels: { ...params.labels as Record<string, string> }, keep: params.keep === true });
          const program = run.foreground!.argv[0]!;
          if (program === "claude" || program === "pi") run.status = { state: "idle", app: program === "claude" ? "claude-code" : "pi" };
          options.start?.(run);
          return coreOk(view(run));
        }
        case "terminal.wait":
          if (t!.state === "finished") return waited(t!, true, "exit", null);
          if (t!.status === null || t!.status.state === "working") return waited(t!, false, "timeout", t!.status?.state ?? null);
          return waited(t!, true, "status", t!.status.state);
        case "terminal.send":
          if (t!.state === "finished") return coreError("finished", `${t!.address} has finished`);
          if (t!.status?.state === "blocked") return coreError("blocked", `${t!.address} is blocked`);
          t!.sent.push(params.text as string);
          return coreOk({ started: null, status: t!.status?.state ?? null, turn: 0, wait: null });
        case "terminal.keys":
          t!.keys.push(params.keys as string[]);
          return coreOk({ status: t!.status?.state ?? null, turn: 0 });
        case "terminal.kill":
          if (t!.state === "live") finish(t!, null);
          return coreOk(view(t!));
        case "terminal.rm":
          if (t!.state === "live") return coreError("live", `${t!.address} is still running`);
          terminals.splice(terminals.indexOf(t!), 1);
          return coreOk({ removed: t!.address });
        default: throw new Error(`the fake core has no ${method}`);
      }
    },
  };
  return fake;
}
