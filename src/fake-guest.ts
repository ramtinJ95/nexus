/**
 * Test double for Guest. It records every exec argv and every written file, and answers each exec from a
 * script. The `herdr*` helpers print what Herdr 0.9.5's CLI prints: one JSON line, `{ id, result }` with
 * exit 0, or `{ id, error }` with exit 1.
 */
import type { Guest } from "./backend.ts";
import type { OverlayFile } from "./project.ts";

export type ExecReply = { exitCode: number | null; output: string; truncated?: boolean };

export interface FakeGuest extends Guest {
  readonly execs: (readonly string[])[];
  readonly written: OverlayFile[];
  /** The Herdr subcommands run so far, such as "workspace create", in order. */
  herdrCalls(): string[];
}

/** `script` gets the argv after `herdr --session nexus` for Herdr calls, and the whole argv for anything else. */
export function fakeGuest(script: (argv: readonly string[], herdr: boolean) => ExecReply): FakeGuest {
  const execs: (readonly string[])[] = [];
  const written: OverlayFile[] = [];
  const isHerdr = (argv: readonly string[]) => argv[0] === "herdr" && argv[1] === "--session";
  return {
    execs,
    written,
    herdrCalls: () => execs.filter(isHerdr).map((argv) => argv.slice(3, 5).join(" ")),
    async exec(argv) {
      execs.push(argv);
      const reply = isHerdr(argv) ? script(argv.slice(3), true) : script(argv, false);
      return { truncated: false, ...reply };
    },
    async writeFiles(files) { written.push(...files); },
    stream: () => Promise.reject(new Error("unused")),
    services: () => Promise.reject(new Error("unused")),
    startService: () => Promise.reject(new Error("unused")),
    linkPort: () => Promise.reject(new Error("unused")),
    unlinkPort: () => Promise.reject(new Error("unused")),
    previewOrigin: () => { throw new Error("unused"); },
  };
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
