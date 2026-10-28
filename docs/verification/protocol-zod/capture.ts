/**
 * Prints what every payload in cases.ts gets from the checkout given as the first argument, one line per case: a hash
 * of the value the parser hands on, or the error it throws, or the HTTP status and body the probe answers. It reads each payload through the code a node or the control
 * plane runs: the probe's real HTTP routes (PUT /v1/jobs, POST /v1/pylons/{id}/commands, the stream upgrade), the
 * control plane's real probe client against a stub probe, the parsers those call, and the Herdr session reads with
 * a fake guest. It imports the checkout given as its argument, so run.sh runs it unchanged against main and the
 * branch.
 *
 *   node docs/verification/protocol-zod/capture.ts <checkout> <out-file>
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import * as cases from "./cases.ts";

const root = resolve(process.argv[2]!);
const out = process.argv[3]!;
const src = (path: string) => import(join(root, "src", path));
const protocol = await src("protocol.ts");
const sessions = await src("sessions.ts");
const reconcile = await src("reconcile.ts");
const { startProbe } = await src("probe/server.ts");
const { nodeSecrets } = await src("probe/config.ts");
const { fakeGuest } = await src("fake-guest.ts");

const lines: string[] = [];
/** What `value` holds, keys in order, undefined ones too, hashed to keep the capture small: equal hashes mean equal values. */
const shown = (value: unknown) => createHash("sha256").update(inspect(value, { depth: null, compact: true, breakLength: Infinity })).digest("hex").slice(0, 16);
const say = (id: string, outcome: string) => lines.push(`${id} => ${outcome}`);
async function attempt(id: string, run: () => unknown) {
  try {
    say(id, `ok ${shown(await run())}`);
  } catch (err) {
    say(id, `threw ${JSON.stringify((err as Error).message)}`);
  }
}

const controlPlane = "nCONTROL";
const pylonId = "pylon-th-1";
const backend = {
  list: async () => [],
  artifacts: { list: async () => [], manifest: async () => null },
  guest: () => { throw new Error("no guest"); },
};
const probe = await startProbe({
  node: cases.node, host: "127.0.0.1", port: 0, auth: { controlPlane, peers: [] }, whois: async () => controlPlane,
  backend, secrets: nodeSecrets({ value: () => undefined, names: () => [] }), log: () => undefined,
});

function http(method: string, path: string, body: string): Promise<string> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port: probe.port, method, path, headers: { "content-type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk) => { text += chunk; }).on("end", () => done(`${res.statusCode} ${JSON.stringify(text)}`));
    });
    req.on("error", fail);
    req.end(body);
  });
}

/** The status line and body the probe answers an upgrade request with, or the upgrade itself. */
function upgrade(path: string, protocolName: string | undefined): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(probe.port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nhost: probe\r\nconnection: upgrade\r\n${protocolName === undefined ? "" : `upgrade: ${protocolName}\r\n`}\r\n`);
    });
    let text = "";
    socket.setEncoding("utf8").on("data", (chunk) => { text += chunk; }).on("end", () => done(JSON.stringify(text.replace(/\r\ndate: [^\r]*/i, "")))).on("error", fail);
  });
}

for (const c of cases.envelopeCases()) {
  const body = JSON.stringify(c.value);
  await attempt(`parseJobEnvelope ${c.id}`, () => protocol.parseJobEnvelope(body));
  say(`PUT /v1/jobs ${c.id}`, await http("PUT", `/v1/jobs/${cases.jobId}`, body));
}
for (const body of ["", "{", "not json"]) {
  await attempt(`parseJobEnvelope body ${JSON.stringify(body)}`, () => protocol.parseJobEnvelope(body));
  say(`PUT /v1/jobs body ${JSON.stringify(body)}`, await http("PUT", `/v1/jobs/${cases.jobId}`, body));
}

for (const c of cases.commandCases()) {
  const body = JSON.stringify(c.value);
  await attempt(`parsePylonCommand ${c.id}`, () => protocol.parsePylonCommand(body));
  say(`POST commands ${c.id}`, await http("POST", `/v1/pylons/${pylonId}/commands`, body));
}
for (const body of ["", "{", "not json"]) {
  await attempt(`parsePylonCommand body ${JSON.stringify(body)}`, () => protocol.parsePylonCommand(body));
  say(`POST commands body ${JSON.stringify(body)}`, await http("POST", `/v1/pylons/${pylonId}/commands`, body));
}

for (const c of cases.streamCases()) {
  await attempt(`parseStreamRequest ${c.id}`, () => protocol.parseStreamRequest(c.upgrade, new URL(c.path, "http://probe")));
  say(`GET stream ${c.id}`, await upgrade(c.path, c.upgrade));
}
await probe.close();

for (const c of cases.eventCases()) await attempt(`parseProbeEvent ${c.id}`, () => protocol.parseProbeEvent(JSON.stringify(c.value)));
for (const probe of ["deployed", "main", "branch"]) {
  const frame = await readFile(join(root, "docs/verification/upgrade-observations", `probe-${probe}.json`), "utf8");
  await attempt(`parseProbeEvent first snapshot of a real ${probe} probe`, () => JSON.stringify(protocol.parseProbeEvent(frame.trim())));
}
for (const [name, job] of Object.entries(cases.jobs)) {
  const body = JSON.stringify(reconcile.envelope(job, cases.node, Date.parse("2026-10-27T12:00:00Z")));
  await attempt(`parseJobEnvelope as the control plane's envelope() writes it ${name}`, () => JSON.stringify(protocol.parseJobEnvelope(body)).replace(/"jobId":"[^"]*"/, '"jobId":"<uuid>"'));
}
for (const frame of ["", "{", "[]"]) await attempt(`parseProbeEvent frame ${JSON.stringify(frame)}`, () => protocol.parseProbeEvent(frame));
for (const c of cases.submitReplyCases()) await attempt(`parseSubmitReply ${c.status} ${c.id}`, () => protocol.parseSubmitReply(c.status, JSON.stringify(c.value)));
for (const c of cases.manifestCases()) await attempt(`parseArtifactManifest ${c.id}`, () => protocol.parseArtifactManifest(c.value));

let stubBody = "";
const stub = createServer((req, res) => {
  req.resume().on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(stubBody));
}).listen(0, "127.0.0.1");
await new Promise((ready) => stub.once("listening", ready));
const client = protocol.connectProbe(cases.node, "127.0.0.1", "nPROBE", { port: (stub.address() as { port: number }).port, whois: async () => "nPROBE" });
for (const c of cases.resultCases()) {
  stubBody = JSON.stringify(c.value);
  await attempt(`client.command ${c.id}`, () => client.command(pylonId, c.command));
}
for (const c of cases.statusCases()) {
  stubBody = JSON.stringify(c.value);
  await attempt(`client.job ${c.id}`, () => client.job(cases.jobId));
}
for (const c of cases.manifestCases()) {
  stubBody = JSON.stringify(c.value);
  await attempt(`client.manifest ${c.id}`, () => client.manifest("img-abc123"));
}
for (const c of cases.submitReplyCases().filter((c) => c.status === 200)) {
  stubBody = JSON.stringify(c.value);
  await attempt(`client.submit ${c.id}`, () => client.submit({ ...cases.envelope(cases.jobs.delete), notAfter: "2100-01-01T00:00:00.000Z" }));
}
stub.close();

type Reply = { exitCode: number | null; output: string };
const herdrLine = (value: unknown, exitCode = 0): Reply => ({ exitCode, output: `${JSON.stringify(value)}\n` });
const ok = (result: unknown) => herdrLine({ id: "cli:1", result });
/** A guest whose Herdr answers `answers` by subcommand, and whose sessions file is `file`, or none. */
const guest = (answers: Record<string, () => Reply>, file: unknown = null) => fakeGuest((argv: readonly string[], herdr: boolean) => {
  if (!herdr) return file === null ? { exitCode: 3, output: "" } : { exitCode: 0, output: typeof file === "string" ? file : JSON.stringify(file) };
  const answer = answers[argv.slice(0, 2).join(" ")];
  return answer === undefined ? ok({}) : answer();
});

for (const c of cases.sessionsFileCases()) {
  const text = JSON.stringify(c.value);
  await attempt(`pausedSessionsIn ${c.id}`, () => sessions.pausedSessionsIn(text));
  await attempt(`sessionFacts file ${c.id}`, () => sessions.sessionFacts(guest({ "api snapshot": () => ok(cases.herdrSnapshot) }, text)));
}
for (const text of ["", "{", "[]"]) await attempt(`pausedSessionsIn text ${JSON.stringify(text)}`, () => sessions.pausedSessionsIn(text));
for (const c of cases.herdrSnapshotCases()) {
  await attempt(`sessionFacts snapshot ${c.id}`, () => sessions.sessionFacts(guest({ "api snapshot": () => ok(c.value) }, cases.sessionsFile)));
}
for (const c of cases.herdrReplyCases()) {
  const exitCode = c.id.startsWith("herdr-reply error") ? 1 : 0;
  const reply = () => herdrLine(c.value, exitCode);
  await attempt(`openSession ${c.id}`, () => sessions.openSession(guest({ "workspace create": reply }), { harness: "shell", title: "sh", cwd: "/home/user" }));
  const claudePane = { snapshot: { workspaces: [{ workspace_id: "w1", label: "review" }], panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent: "claude", agent_status: "idle", cwd: "/home/user", foreground_cwd: null, agent_session: null }] } };
  const recording = guest({ "api snapshot": () => ok(claudePane), "pane process-info": reply });
  await attempt(`recordSessions ${c.id}`, async () => ({ recorded: await sessions.recordSessions(recording), written: recording.written.map((f: { content: string }) => f.content.replace(/"recordedAt": "[^"]*"/, '"recordedAt": "<time>"')) }));
  await attempt(`closeSession ${c.id}`, () => sessions.closeSession(guest({ "pane close": reply }), "w1:p1"));
}

await writeFile(out, `${lines.join("\n")}\n`);
