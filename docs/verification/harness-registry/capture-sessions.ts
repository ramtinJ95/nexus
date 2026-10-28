// Writes what a probe does in a pylon's guest for each session harness, against a fake guest whose Herdr and sessions
// file change as the calls act on them: every guest exec, in order, with its options, every file written, and what each
// call returns, for opens, records, session facts, relaunches, closes, the pause and wake log lines, and the paused
// sessions a stopped pylon VM reports from its checkpoint sidecar.
// Run from the root of a checkout: node docs/verification/harness-registry/capture-sessions.ts <out-file>
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { json, normaliser, short } from "./normalise.ts";

const { openSession, recordSessions, relaunchSessions, sessionFacts, closeSession, pausedSessionsIn, sessionsFile, checkoutDir } = await import("../../../src/sessions.ts");
const { recordBeforePause, relaunchAfterWake } = await import("../../../src/session-wake.ts");
const { fakeGuest, herdrError, herdrOk, herdrPane, herdrSnapshot } = await import("../../../src/fake-guest.ts");
const { createPylonVmBackend } = await import("../../../src/pylon-vm-backend.ts");
type ExecReply = import("../../../src/fake-guest.ts").ExecReply;
type Guest = import("../../../src/backend.ts").Guest;
type PylonId = import("../../../src/protocol.ts").PylonId;

const out = process.argv[2]!;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

interface Pane { workspace: string; label: string; pane: string; cwd: string; agent: string | null; session: { kind: "id" | "path"; value: string } | null; status: string; foreground: readonly string[] }

interface Pylon {
  /** The sessions file's text at the start, or null when there is none. */
  file?: string | null;
  panes?: Pane[];
  /** Claude Code session IDs that have a transcript. */
  transcripts?: readonly string[];
  /** Whether a Herdr server runs, and whether starting one fails. */
  server?: "up" | "down" | "fails";
  /** A reply that replaces an agent start's. The start runs the agent in its pane unless `runs` is false. */
  agentStart?: (argv: readonly string[], attempt: number) => { reply: ExecReply; runs?: boolean } | undefined;
  /** A reply that replaces a pane's process info. */
  processInfo?: (pane: string) => ExecReply | undefined;
  snapshot?: () => ExecReply | undefined;
  /** Whether closing a workspace fails. */
  closeFails?: boolean;
  screen?: string;
}

const shell = (workspace: string, label: string, cwd = "/home/user", pane = `${workspace}:p1`): Pane =>
  ({ workspace, label, pane, cwd, agent: null, session: null, status: "unknown", foreground: ["-bash"] });
const agent = (workspace: string, label: string, kind: string, session: Pane["session"], foreground: readonly string[], status = "idle", pane = `${workspace}:p1`): Pane =>
  ({ workspace, label, pane, cwd: "/home/user", agent: kind, session, status, foreground });

const launches = "/home/user/.nexus/claude-launches/";

/** A guest whose Herdr and files follow the calls made on it, and the ordered log of those calls. */
function pylon(options: Pylon = {}) {
  const panes = options.panes ?? [];
  const files = new Map<string, string>();
  if (options.file != null) files.set(sessionsFile, options.file);
  let server = options.server ?? "up";
  let next = 20;
  const starts = new Map<string, number>();
  const events: string[] = [];
  const flag = (argv: readonly string[], name: string) => argv[argv.indexOf(name) + 1]!;
  const find = (id: string) => panes.find((p) => p.pane === id);
  function herdr(argv: readonly string[]): ExecReply {
    if (server !== "up") return herdrError("server_not_running", "no server");
    const sub = argv.slice(0, 2).join(" ");
    switch (sub) {
      case "workspace list": return herdrOk({ type: "workspace_list", workspaces: [] });
      case "api snapshot": return options.snapshot?.() ?? herdrOk(herdrSnapshot(
        [...new Map(panes.map((p) => [p.workspace, { id: p.workspace, label: p.label }])).values()],
        panes.map((p) => herdrPane(p.pane, p.workspace, p.agent, p.status, p.session, p.cwd)),
      ));
      case "workspace create": {
        const workspace = `w${next++}`;
        panes.push(shell(workspace, flag(argv, "--label"), flag(argv, "--cwd")));
        return herdrOk({ type: "workspace_created", workspace: { workspace_id: workspace, label: flag(argv, "--label") }, tab: { tab_id: `${workspace}:t1` }, root_pane: { pane_id: `${workspace}:p1` } });
      }
      case "workspace close":
        if (options.closeFails) return herdrError("workspace_not_found", "gone");
        panes.splice(0, panes.length, ...panes.filter((p) => p.workspace !== argv[2]));
        return herdrOk({ type: "ok" });
      case "pane close":
        if (find(argv[2]!) === undefined) return herdrError("pane_not_found", `no pane ${argv[2]}`);
        panes.splice(0, panes.length, ...panes.filter((p) => p.pane !== argv[2]));
        return herdrOk({ type: "ok" });
      case "pane process-info": {
        const pane = argv[3]!;
        const replaced = options.processInfo?.(pane);
        if (replaced) return replaced;
        const p = find(pane);
        if (p === undefined) return herdrError("pane_not_found", `no pane ${pane}`);
        return herdrOk({ type: "pane_process_info", process_info: { pane_id: pane, shell_pid: 100, foreground_processes: [{ pid: p.foreground[0] === "-bash" ? 100 : 101, name: p.foreground[0]!, argv: p.foreground }] } });
      }
      case "pane read": return herdrOk({ type: "pane_read", read: { text: options.screen ?? "user@pylon:~$ " } });
      case "pane run": {
        const p = find(argv[2]!)!;
        Object.assign(p, { agent: "claude", status: "working", foreground: ["claude", "(typed)"] });
        const hook = /touch (\S+?)\/submitted/.exec(argv[3]!);
        if (hook) files.set(`${hook[1]}/submitted`, "");
        return { exitCode: 0, output: "" };
      }
      case "agent start": {
        const pane = flag(argv, "--pane");
        const attempt = (starts.get(pane) ?? 0) + 1;
        starts.set(pane, attempt);
        const replaced = options.agentStart?.(argv, attempt);
        if (replaced && replaced.runs === false) return replaced.reply;
        const p = find(pane)!;
        const kind = flag(argv, "--kind");
        const args = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
        const named = args.findIndex((a) => a === "--session-id" || a === "--resume" || a === "--session");
        Object.assign(p, {
          agent: kind, status: "idle", foreground: [kind, ...args],
          session: named === -1 ? null : { kind: args[named] === "--session" ? "path" : "id", value: args[named + 1]! },
        });
        return replaced?.reply ?? herdrOk({ type: "agent_started", agent: {}, argv: [] });
      }
    }
    return { exitCode: 2, output: `unscripted herdr ${argv.join(" ")}` };
  }
  function other(argv: readonly string[]): ExecReply {
    if (argv[0] === "node" && argv[1] === "-e") return { exitCode: 0, output: "" };
    if (argv[0] === "sh" && argv.at(-1) === sessionsFile) {
      const text = files.get(sessionsFile);
      return text === undefined ? { exitCode: 3, output: "" } : { exitCode: 0, output: text };
    }
    if (argv[0] === "sh" && argv.at(-1) === "/home/user/.claude/projects") return { exitCode: (options.transcripts ?? []).includes(argv[3]!) ? 0 : 1, output: "" };
    if (argv[0] === "sh" && argv[2]?.startsWith("setsid ")) {
      if (server === "fails") return { exitCode: 1, output: "herdr: cannot start" };
      server = "up";
      return { exitCode: 0, output: "" };
    }
    if (argv[0] === "sh" && argv[2]?.startsWith("test -f") && argv[3]?.startsWith(launches)) {
      const opened = files.get(`${argv[3]}/opened`);
      return { exitCode: 0, output: opened === undefined ? "" : opened + (files.has(`${argv[3]}/typed`) ? "typed\n" : "") };
    }
    if (argv[0] === "sh" && argv[3] === "shell-ready") return { exitCode: 0, output: "" };
    if (argv[0] === "sh" && argv[3] === "claude-submitted") return { exitCode: files.has(argv[4]!) ? 0 : 1, output: "" };
    if (argv[0] === "sh" && argv[4] === "herdr") {
      if (files.has(argv[3]!)) return { exitCode: 75, output: "" };
      files.set(argv[3]!, "");
      return herdr(argv.slice(7));
    }
    return { exitCode: 2, output: `unscripted ${argv.join(" ")}` };
  }
  const base = fakeGuest((argv, isHerdr) => isHerdr ? herdr(argv) : other(argv));
  const guest: Guest = {
    ...base,
    async exec(argv, opts) {
      events.push(`exec ${json(argv, 400)} cwd=${opts.cwd} timeoutMs=${opts.timeoutMs}`);
      return base.exec(argv, opts);
    },
    async writeFiles(written) {
      for (const f of written) {
        events.push(`write ${f.path} mode=${f.mode.toString(8)} owner=${f.owner}`);
        for (const line of f.content.trimEnd().split("\n")) events.push(`  | ${line}`);
        files.set(f.path, f.content);
      }
    },
  };
  return { guest, events, panes, files };
}

/** Runs `act` on a fresh pylon and logs every guest call it made, then what it returned or why it rejected. */
async function capture(title: string, options: Pylon, act: (guest: Guest, p: ReturnType<typeof pylon>) => Promise<unknown>, extra: (p: ReturnType<typeof pylon>) => string[] = () => [], events = true) {
  const norm = normaliser();
  const p = pylon(options);
  let result: string;
  try {
    result = `returns ${json(await act(p.guest, p), 400)}`;
  } catch (err) {
    result = `rejects ${JSON.stringify((err as Error).message)}${err instanceof Error && "herdrPane" in err ? ` herdrPane=${String(err.herdrPane)}` : ""}`;
  }
  log("");
  log(`## ${title}`);
  for (const line of [...events ? p.events : [], result, ...extra(p)]) log(norm(line));
}

const panesAfter = (p: ReturnType<typeof pylon>) => [`panes after: ${json(p.panes.map((x) => [x.pane, x.label, x.agent, x.session?.value ?? null, x.foreground]), 400)}`];

const file = (sessions: readonly object[], failed: readonly object[] = []) => JSON.stringify({ version: 1, recordedAt: "2027-01-01T00:00:00Z", sessions, failed });
const record = (herdrPaneId: string, harness: string, title: string, harnessSessionId: string | null, extra: object = {}) =>
  ({ herdrPane: herdrPaneId, harness, title, cwd: "/home/user", harnessSessionId, ...extra });

log("# openSession");
const harnesses = ["claude-code", "pi", "shell"] as const;
for (const harness of harnesses) {
  await capture(`${harness}: fresh`, {}, (g) => openSession(g, { harness, title: "t", cwd: checkoutDir }));
  await capture(`${harness}: fresh, no Herdr server yet`, { server: "down" }, (g) => openSession(g, { harness, title: "t", cwd: checkoutDir }));
  await capture(`${harness}: fresh, a Herdr server that fails to start`, { server: "fails" }, (g) => openSession(g, { harness, title: "t", cwd: checkoutDir }));
  if (harness !== "shell") {
    await capture(`${harness}: resume, with a transcript`, { transcripts: ["bd2c2d6b"] }, (g) => openSession(g, { harness, title: "t", cwd: "/home/user", resume: "bd2c2d6b" }));
    await capture(`${harness}: resume, with no transcript`, {}, (g) => openSession(g, { harness, title: "t", cwd: "/home/user", resume: "bd2c2d6b" }));
    await capture(`${harness}: resume of a session file path`, {}, (g) => openSession(g, { harness, title: "t", cwd: "/home/user", resume: "/home/user/.pi/agent/sessions/s.jsonl" }));
  }
  const refused = { reply: herdrError("timeout", "timed out waiting for agent"), runs: false };
  await capture(`${harness}: the agent start fails and the pane runs only its shell`, { agentStart: () => refused, screen: "No conversation found\nuser@pylon:~$ " }, (g) => openSession(g, { harness, title: "t", cwd: "/home/user" }), panesAfter);
  await capture(`${harness}: the agent start fails but the pane runs the agent`, { agentStart: () => ({ reply: herdrError("timeout", "timed out waiting for agent") }) }, (g) => openSession(g, { harness, title: "t", cwd: "/home/user" }), panesAfter);
  await capture(`${harness}: the agent start fails and the pane cannot be inspected`, { agentStart: () => refused, processInfo: () => herdrError("timeout", "process-info timed out") }, (g) => openSession(g, { harness, title: "t", cwd: "/home/user" }), panesAfter);
  await capture(`${harness}: the agent start fails and so does the rollback`, { agentStart: () => refused, closeFails: true }, (g) => openSession(g, { harness, title: "t", cwd: "/home/user" }), panesAfter);
  await capture(`${harness}: the agent is blocked at startup`, { agentStart: () => ({ reply: herdrError("agent_not_ready", "agent is blocked") }) }, (g) => openSession(g, { harness, title: "t", cwd: "/home/user" }), panesAfter);
  await capture(`${harness}: the pane is busy twice, then the agent starts`, { agentStart: (_argv, attempt) => attempt <= 2 ? { reply: herdrError("agent_pane_busy", "busy"), runs: false } : undefined }, (g) => openSession(g, { harness, title: "t", cwd: "/home/user" }));
}
await capture("claude-code: fresh with a model", {}, (g) => openSession(g, { harness: "claude-code", title: "t", cwd: checkoutDir, model: "claude-opus-5-5" }));
await capture("claude-code: resume with a model", { transcripts: ["bd2c2d6b"] }, (g) => openSession(g, { harness: "claude-code", title: "t", cwd: checkoutDir, resume: "bd2c2d6b", model: "opus" }));
await capture("claude-code: a prompted launch under a session ID, with a model", {}, (g) => openSession(g, { harness: "claude-code", title: "worker", cwd: checkoutDir, resume: "launch-0001", prompt: "fix \"it\" and 'that' $HOME !!\nthen test", model: "opus" }), panesAfter);
await capture("claude-code: a prompted launch with no session ID", {}, (g) => openSession(g, { harness: "claude-code", title: "worker", cwd: checkoutDir, prompt: "work" }));
await capture("claude-code: a prompted launch whose session already has a transcript", { transcripts: ["launch-0002"] }, (g) => openSession(g, { harness: "claude-code", title: "worker", cwd: checkoutDir, resume: "launch-0002", prompt: "work" }), panesAfter);
await capture("claude-code: a prompted launch under a session ID Nexus refuses", {}, (g) => openSession(g, { harness: "claude-code", title: "worker", cwd: checkoutDir, resume: "not/an id", prompt: "work" }));
await capture("claude-code: a prompted launch whose Claude already runs the session", { panes: [agent("w1", "worker", "claude", null, ["claude", "--session-id", "launch-0003"], "working")] }, (g) => openSession(g, { harness: "claude-code", title: "worker", cwd: checkoutDir, resume: "launch-0003", prompt: "work" }));
await capture("pi: a prompt and model, which the protocol refuses before a probe sees them", {}, (g) => openSession(g, { harness: "pi", title: "t", cwd: "/home/user", prompt: "work", model: "gpt" }));

log("");
log("# recordSessions");
const mixed = (ids: boolean): Pane[] => [
  agent("w1", "review", "claude", ids ? { kind: "id", value: "aaaa" } : null, ["claude", "--session-id", "aaaa", "--model", "opus"], "working"),
  agent("w2", "resumed", "claude", null, ["node", "/usr/local/bin/claude", "--resume", "bbbb"]),
  agent("w3", "by hand", "claude", null, ["claude"]),
  agent("w4", "plan", "pi", ids ? { kind: "path", value: "/home/user/.pi/agent/sessions/s.jsonl" } : null, ["pi", "--session-id", "pppp", "--model", "gpt"], "blocked"),
  shell("w5", "sh", "/home/user/app"),
  agent("w6", "codex", "codex", ids ? { kind: "id", value: "codex-1" } : null, ["codex", "--session-id", "cccc", "--model", "o3"]),
  { ...shell("w5", "sh", "/home/user"), pane: "w5:p2" },
];
await capture("claude, pi, a shell and codex, with Herdr's session IDs", { panes: mixed(true) }, (g) => recordSessions(g));
await capture("claude, pi, a shell and codex, without Herdr's session IDs", { panes: mixed(false) }, (g) => recordSessions(g));
await capture("a Claude pane that closed before its command line was read", {
  panes: [agent("w1", "gone", "claude", null, ["claude"])], processInfo: (pane) => pane === "w1:p1" ? herdrError("pane_not_found", "gone") : undefined,
}, (g) => recordSessions(g));
await capture("a Claude pane whose command line cannot be read", {
  panes: [agent("w1", "review", "claude", null, ["claude"])], processInfo: () => herdrError("timeout", "process-info timed out"),
}, (g) => recordSessions(g));
await capture("no Herdr server", { server: "down" }, (g) => recordSessions(g));
await capture("failed records of each harness, in panes still open and in none", {
  panes: [shell("w1", "review"), shell("w2", "plan"), shell("w3", "sh")],
  file: file([], [
    { record: record("w1:p1", "claude-code", "review", "aaaa"), inPane: true, message: "claude did not start" },
    { record: record("w2:p1", "pi", "plan", "/s.jsonl"), inPane: true, message: "pi did not start" },
    { record: record("w9:p1", "claude-code", "old", "bbbb", { model: "opus" }), inPane: false, message: "claude did not start" },
    { record: record("w8:p1", "pi", "old plan", null), inPane: false, message: "pi did not start" },
    { record: record("w7:p1", "shell", "old sh", null), inPane: false, message: "no such directory" },
    { record: record("w6:p1", "pi", "closed", null), inPane: true, message: "pi did not start" },
  ]),
}, (g) => recordSessions(g));

log("");
log("# sessionFacts");
await capture("each harness in each Herdr status, with failed records of each harness", {
  panes: [
    agent("w1", "review", "claude", { kind: "id", value: "aaaa" }, ["claude"], "working"),
    agent("w2", "plan", "pi", { kind: "path", value: "/s.jsonl" }, ["pi"], "blocked"),
    { ...shell("w3", "sh"), status: "idle" },
    agent("w4", "codex", "codex", { kind: "id", value: "codex-1" }, ["codex"], "done"),
    agent("w5", "no id", "claude", null, ["claude"], "unknown"),
    shell("w7", "failed in pane"),
  ],
  file: file([], [
    { record: record("w7:p1", "claude-code", "failed in pane", "dddd"), inPane: true, message: "claude did not start" },
    ...harnesses.map((h, i) => ({ record: record(`w${10 + i}:p1`, h, `failed ${h}`, h === "shell" ? null : `${h}-id`), inPane: false, message: `${h} did not start` })),
  ]),
}, (g) => sessionFacts(g));
await capture("no Herdr server and no sessions file", { server: "down" }, (g) => sessionFacts(g));

log("");
log("# relaunchSessions, with the Claude sessions it holds exclusively, then what recordSessions reads back from the file it leaves");
const relaunches: [string, () => Pylon][] = [
  ["duplicate Claude records, duplicate pi records, shells sharing a title, records with models, records with no ID", () => ({
    transcripts: ["aaaa"],
    panes: [shell("w8", "sh", "/b")],
    file: file([
      record("w1:p1", "claude-code", "review", "aaaa", { model: "opus" }),
      record("w2:p1", "claude-code", "review copy", "aaaa"),
      record("w3:p1", "claude-code", "fresh", "bbbb"),
      record("w4:p1", "pi", "plan", "/home/user/.pi/agent/sessions/s.jsonl", { model: "gpt" }),
      record("w5:p1", "pi", "plan again", "/home/user/.pi/agent/sessions/s.jsonl"),
      { ...record("w6:p1", "shell", "sh", null), cwd: "/a" },
      { ...record("w7:p1", "shell", "sh", null), cwd: "/b" },
      record("w9:p1", "claude-code", "by hand", null),
      record("w10:p1", "pi", "pi fresh", null),
    ]),
  })],
  ["Herdr restored each pane in place as a shell", () => ({
    transcripts: ["aaaa"],
    panes: [shell("w1", "review"), shell("w2", "plan"), shell("w3", "sh")],
    file: file([record("w1:p1", "claude-code", "review", "aaaa", { model: "opus" }), record("w2:p1", "pi", "plan", "/s.jsonl"), record("w3:p1", "shell", "sh", null)]),
  })],
  ["panes Herdr still reports as Claude and pi, but that run only their shells", () => ({
    transcripts: ["aaaa"],
    panes: [agent("w1", "review", "claude", { kind: "id", value: "aaaa" }, ["-bash"]), agent("w2", "plan", "pi", { kind: "path", value: "/s.jsonl" }, ["-bash"])],
    file: file([record("w1:p1", "claude-code", "review", "aaaa"), record("w2:p1", "pi", "plan", "/s.jsonl")]),
  })],
  ["every agent already runs, pi and Claude under node", () => ({
    panes: [
      agent("w1", "review", "claude", { kind: "id", value: "aaaa" }, ["node", "/usr/local/bin/claude", "--resume", "aaaa"]),
      agent("w2", "plan", "pi", { kind: "path", value: "/s.jsonl" }, ["node", "/usr/local/bin/pi", "--session", "/s.jsonl"]),
      agent("w3", "plan again", "pi", { kind: "path", value: "/s.jsonl" }, ["pi", "--session", "/s.jsonl"]),
      shell("w4", "sh"),
    ],
    file: file([record("w1:p1", "claude-code", "review", "aaaa"), record("w2:p1", "pi", "plan", "/s.jsonl"), record("w3:p1", "pi", "plan again", "/s.jsonl"), record("w4:p1", "shell", "sh", null)]),
  })],
  ["a duplicate Claude record whose pane runs the session, and one whose pane does not", () => ({
    transcripts: ["aaaa"],
    panes: [shell("w1", "first"), agent("w2", "second", "claude", { kind: "id", value: "aaaa" }, ["claude", "--resume", "aaaa"])],
    file: file([record("w1:p1", "claude-code", "first", "aaaa"), record("w2:p1", "claude-code", "second", "aaaa"), record("w3:p1", "claude-code", "third", "aaaa")]),
  })],
  ["two records each of one Claude session and one pi session, each record in a shell Herdr restored", () => ({
    transcripts: ["aaaa"],
    panes: [shell("w1", "first"), shell("w2", "second"), shell("w3", "plan"), shell("w4", "plan again")],
    file: file([record("w1:p1", "claude-code", "first", "aaaa"), record("w2:p1", "claude-code", "second", "aaaa"), record("w3:p1", "pi", "plan", "/s.jsonl"), record("w4:p1", "pi", "plan again", "/s.jsonl")]),
  })],
  ["a Claude session and a pi session whose panes cannot be inspected", () => ({
    panes: [agent("w1", "review", "claude", { kind: "id", value: "aaaa" }, ["claude"]), shell("w2", "review copy"), agent("w3", "plan", "pi", { kind: "path", value: "/s.jsonl" }, ["pi"]), shell("w4", "plan again")],
    processInfo: (pane) => pane === "w1:p1" || pane === "w3:p1" ? herdrError("timeout", "process-info timed out") : undefined,
    file: file([record("w1:p1", "claude-code", "review", "aaaa"), record("w2:p1", "claude-code", "review copy", "aaaa"), record("w3:p1", "pi", "plan", "/s.jsonl"), record("w4:p1", "pi", "plan again", "/s.jsonl")]),
  })],
  ["every agent start fails", () => ({
    agentStart: () => ({ reply: herdrError("timeout", "the agent did not start"), runs: false }),
    panes: [shell("w2", "plan")],
    file: file([record("w1:p1", "claude-code", "review", "aaaa"), record("w2:p1", "pi", "plan", "/s.jsonl"), record("w3:p1", "shell", "sh", null)]),
  })],
  ["no Herdr server, and starting one fails", () => ({
    server: "fails",
    file: file([record("w1:p1", "claude-code", "review", "aaaa"), record("w2:p1", "pi", "plan", "/s.jsonl"), record("w3:p1", "shell", "sh", null)]),
  })],
  ["failed records of each harness from the last wake, which come back this time", () => ({
    transcripts: ["aaaa"],
    panes: [shell("w1", "review")],
    file: file([], [
      { record: record("w1:p1", "claude-code", "review", "aaaa"), inPane: true, message: "claude did not start" },
      { record: record("w2:p1", "pi", "plan", "/s.jsonl"), inPane: false, message: "pi did not start" },
      { record: record("w3:p1", "shell", "sh", null), inPane: false, message: "no such directory" },
    ]),
  })],
  ["no sessions file", () => ({ file: null })],
];
for (const [title, scenario] of relaunches) {
  await capture(title, scenario(), (g, p) => relaunchSessions(g, async (sessions, work) => {
    p.events.push(`exclusive ${json(sessions)}`);
    return work();
  }), panesAfter);
  await capture(`${title}: then recordSessions`, scenario(), async (g, p) => {
    await relaunchSessions(g);
    p.events.length = 0;
    return recordSessions(g);
  });
}

log("");
log("# relaunchAfterWake: the pylon log's sessions lines for the same pylons (guest calls as above)");
for (const [title, scenario] of relaunches) {
  const logged: string[] = [];
  await capture(title, scenario(), async (g) => (await relaunchAfterWake("pylon-th-000000000001" as PylonId, g, async (line) => { logged.push(line); })).map((o) => o.result), () => logged.map((line) => `log: ${line}`), false);
}
{
  const logged: string[] = [];
  await capture("a sessions file that cannot be read", { file: "{not json" }, async (g) => relaunchAfterWake("pylon-th-000000000001" as PylonId, g, async (line) => { logged.push(line); }), () => logged.map((line) => `log: ${line}`), false);
}

log("");
log("# recordBeforePause: what a pause keeps beside its checkpoint, and its log line");
for (const [title, options] of [
  ["claude, pi, a shell and codex", { panes: mixed(true) }],
  ["failed records of each harness", {
    panes: [shell("w1", "review")],
    file: file([], [
      { record: record("w1:p1", "claude-code", "review", "aaaa", { model: "opus" }), inPane: true, message: "claude did not start" },
      { record: record("w2:p1", "pi", "plan", "/s.jsonl"), inPane: false, message: "pi did not start" },
      { record: record("w3:p1", "shell", "sh", null), inPane: false, message: "no such directory" },
    ]),
  }],
  ["no Herdr server", { server: "down" }],
  ["a Herdr snapshot that does not finish", { snapshot: () => ({ exitCode: null, output: "" }) }],
] as [string, Pylon][]) {
  const logged: string[] = [];
  await capture(title, options, (g) => recordBeforePause(g, async (line) => { logged.push(line); }), () => logged.map((line) => `log: ${line}`));
}

log("");
log("# closeSession");
const open = () => [
  agent("w1", "review", "claude", { kind: "id", value: "aaaa" }, ["claude"]),
  agent("w2", "plan", "pi", { kind: "path", value: "/s.jsonl" }, ["pi"]),
  shell("w3", "sh"),
  agent("w4", "codex", "codex", { kind: "id", value: "codex-1" }, ["codex"]),
  agent("w5", "no id", "claude", null, ["claude"]),
];
const identities: Record<string, { harness: string; harnessSessionId: string | null; title: string | null }> = {
  "w1:p1": { harness: "claude-code", harnessSessionId: "aaaa", title: "review" },
  "w2:p1": { harness: "pi", harnessSessionId: "/s.jsonl", title: "plan" },
  "w3:p1": { harness: "shell", harnessSessionId: null, title: "sh" },
  "w4:p1": { harness: "shell", harnessSessionId: null, title: "codex" },
  "w5:p1": { harness: "claude-code", harnessSessionId: "eeee", title: "no id" },
};
for (const [pane, identity] of Object.entries(identities)) {
  const expectations: [string, typeof identity | undefined][] = [
    ["nothing expected", undefined],
    ["its own identity", identity],
    ...harnesses.filter((h) => h !== identity.harness).map((h): [string, typeof identity] => [`harness ${h}`, { ...identity, harness: h }]),
    ["another session ID", { ...identity, harnessSessionId: "other" }],
    ["no session ID", { ...identity, harnessSessionId: null }],
    ["another title", { ...identity, title: "other" }],
    ["no title", { ...identity, title: null }],
  ];
  for (const [what, expected] of expectations) {
    const norm = normaliser();
    const p = pylon({ panes: open() });
    let result: string;
    try {
      result = await closeSession(p.guest, pane, expected as never);
    } catch (err) {
      result = `rejects ${(err as Error).message}`;
    }
    const herdrCalls = p.events.filter((e) => e.startsWith("exec [\"herdr\"")).map((e) => JSON.parse(e.slice(5, e.indexOf("] cwd=") + 1)).slice(3, 5).join(" "));
    log(norm(`${pane} expecting ${what} ${json(expected ?? null)} => ${result}; herdr calls ${json(herdrCalls)}; other execs ${p.events.filter((e) => e.startsWith("exec ") && !e.startsWith("exec [\"herdr\"")).length}`));
  }
}
for (const [what, options] of [
  ["a pane that is not open", { panes: open() }],
  ["no Herdr server", { server: "down" }],
] as [string, Pylon][]) {
  for (const expected of [undefined, identities["w1:p1"]]) {
    const p = pylon(options);
    log(`w9:p1, ${what}, expecting ${json(expected ?? null)} => ${await closeSession(p.guest, "w9:p1", expected as never).catch((err: Error) => `rejects ${err.message}`)}`);
  }
}

log("");
log("# pausedSessionsIn");
for (const [what, text] of [
  ["sessions and failed records of each harness, with models", file(
    harnesses.map((h, i) => record(`w${i + 1}:p1`, h, h, h === "shell" ? null : `${h}-id`, h === "shell" ? {} : { model: "m" })),
    harnesses.map((h, i) => ({ record: record(`w${i + 4}:p1`, h, `failed ${h}`, null), inPane: i === 0, message: "did not start" })),
  )],
  ["a codex record", file([record("w1:p1", "codex", "codex", null)])],
  ["a record with no harness", file([{ herdrPane: "w1:p1", title: "x", cwd: "/home/user", harnessSessionId: null }])],
  ["a failed record with a toString harness", file([], [{ record: record("w1:p1", "toString", "x", null), inPane: false, message: "m" }])],
  ["a record with an unknown field", file([{ ...record("w1:p1", "pi", "plan", null), extra: 1 }])],
] as const) {
  let result: string;
  try {
    result = json(pausedSessionsIn(text));
  } catch (err) {
    result = `throws ${(err as Error).message}`;
  }
  log(`${what} => ${result}`);
}

log("");
log("# a stopped pylon VM's paused sessions, from its checkpoint sidecar (createPylonVmBackend list)");
const scratch = await mkdtemp("/tmp/nx-hr-");
const artifacts = join(scratch, "artifacts");
await mkdir(artifacts, { recursive: true });
let roots = 0;
for (const [what, sidecar] of [
  ["a paused session of each harness", { checkpoint: "ckpt-0001", sessions: [
    ...harnesses.map((h, i) => ({ id: `w${i + 1}:p1`, herdrPane: `w${i + 1}:p1`, harness: h, harnessSessionId: h === "shell" ? null : `${h}-id`, title: h })),
    { id: "failed-0123456789ab", herdrPane: null, harness: "pi", harnessSessionId: null, title: "plan" },
  ] }],
  ["a pause that recorded nothing", { checkpoint: "ckpt-0002" }],
  ["a paused codex session", { checkpoint: "ckpt-0003", sessions: [{ id: "w1:p1", herdrPane: "w1:p1", harness: "codex", harnessSessionId: null, title: "x" }] }],
  ["a paused session with no harness", { checkpoint: "ckpt-0004", sessions: [{ id: "w1:p1", herdrPane: "w1:p1", harnessSessionId: null, title: "x" }] }],
  ["a paused session with a model", { checkpoint: "ckpt-0005", sessions: [{ id: "w1:p1", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "aaaa", title: "x", model: "opus" }] }],
] as const) {
  const stateRoot = join(scratch, `s${roots++}`);
  const dir = join(stateRoot, "instances", "pylon-t1");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const config = { version: 1, diskGiB: 8, image: join(artifacts, "img-test00000000"), workspace: "/home/user/workspace", setup: [], retrySetup: false, resume: [], services: {} };
  await writeFile(join(dir, "record.json"), JSON.stringify({ version: 1, name: "pylon-t1", config, createdAt: "2026-10-22T00:00:00Z", labels: { "nexus.image": "img-test00000000" } }));
  await writeFile(join(dir, "status.json"), JSON.stringify({ name: "pylon-t1", state: "stopped" }));
  await writeFile(join(dir, "nexus-checkpoint.json"), JSON.stringify(sidecar));
  const backend = createPylonVmBackend({ stateRoot, artifacts, secrets: { value: () => undefined, names: () => [] } });
  let result: string;
  try {
    result = json((await backend.list()).map((p) => ({ pylonId: p.pylonId, vm: p.vm, checkpoint: p.checkpoint, sessions: p.sessions })));
  } catch (err) {
    result = `throws ${short((err as Error).message.replace(/\s+/g, " "), 2000)}`;
  }
  log(`${what} => ${result}`);
}
await rm(scratch, { recursive: true, force: true });

await writeFile(out, lines.join("\n") + "\n");
process.exit(0);
