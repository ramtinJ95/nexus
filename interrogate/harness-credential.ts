/**
 * Design point 3 says each engineer's model subscription is "substituted at the pylon's egress proxy ... only for that
 * user's pylons". A Nexus-agent thread's model calls never leave a pylon: the harness on the control plane makes them.
 *
 * This opens the real harness host (src/control/harness/host.ts) on the real credential store and the real pi-ai
 * openai provider (src/control/harness/credentials.ts), starts one thread for each of two engineers, and records every
 * outbound request the process makes. globalThis.fetch is replaced, so nothing reaches OpenAI.
 *
 *   node interrogate/harness-credential.ts
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessModels, openCredentials } from "../src/control/harness/credentials.ts";
import { openHarnessHost } from "../src/control/harness/host.ts";
import type { PylonId } from "../src/ids.ts";

const scratch = await mkdtemp(join(tmpdir(), "interrogate-harness-"));
const credentialsFile = join(scratch, "harness-credentials.json");
// The one login the control plane holds: whoever ran src/control/login.ts. Here it is alice's.
await writeFile(credentialsFile, JSON.stringify({
  deviceId: "11111111-1111-4111-8111-111111111111",
  credentials: { openai: { type: "api_key", key: "sk-ALICE-the-harness-login" } },
}));

interface Seen { host: string; path: string; authorization: string | null; engineer: string }
const seen: Seen[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body = await request.text();
  seen.push({
    host: url.host, path: url.pathname, authorization: request.headers.get("authorization"),
    engineer: /message from (\w+)/.exec(body)?.[1] ?? "?",
  });
  return new Response(JSON.stringify({ error: { message: "interrogate: no network", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const credentials = await openCredentials(credentialsFile);
const models = harnessModels(credentials);
const modelId = (await models.getAvailable("openai"))[0]!.id;
const host = await openHarnessHost({
  storagePath: join(scratch, "harness.sqlite"), models, model: { provider: "openai", modelId },
  tailscaled: join(scratch, "none.sock"), threads: [], deleted: [], onActivity: () => {}, log: () => {},
  locator: { awaitRunning: () => Promise.reject(new Error("no pylon in this repro")) },
});

// startThread takes a thread and a pylon. Nothing names who started the thread, and send's `sender` is a role.
console.log(`HarnessHost.startThread arity: ${host.startThread.length} (its one argument is { threadId, pylonId })`);
for (const engineer of ["alice", "bob"]) {
  const threadId = `th-${engineer}`;
  await host.startThread({ threadId, pylonId: `pylon-${threadId}` as PylonId });
  await host.send(threadId, `message from ${engineer}`, `m-${engineer}`, "followUp");
}
for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
  if (new Set(seen.map((s) => s.engineer)).size >= 2) break;
  await new Promise((r) => setTimeout(r, 50));
}
const first = new Map<string, Seen>();
for (const s of seen) if (!first.has(s.engineer)) first.set(s.engineer, s);
for (const s of first.values()) console.log(`thread of ${s.engineer}: POST https://${s.host}${s.path} authorization=${s.authorization}`);
const keys = new Set([...first.values()].map((s) => s.authorization));
console.log(keys.size === 1 && first.size === 2
  ? "RESULT: both engineers' threads spent the same credential, sent by the control plane process, with no pylon egress proxy on the path"
  : `RESULT: ${first.size} engineers seen with ${keys.size} credentials`);
await host.close().catch(() => {});
await rm(scratch, { recursive: true, force: true });
process.exit(0);
