/**
 * Test support any test may import: it loads nothing from src/control, so deploy, CLI and probe tests use it without
 * the registry. The registry's fixtures are in src/control/test-kit.ts.
 */
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, type TestContext } from "node:test";
import type { ImageManifest } from "./images.ts";
import type { ImageId, NodeName, PylonId } from "./ids.ts";
import type { NodeCapacity, NodeObservation, PylonObservation } from "./protocol/observations.ts";

/** Waits for the check. The deadline only ends a hang: a loaded suite can take seconds over what takes milliseconds alone. */
export async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Reads whether the promise has settled, after the turns of the event loop it would need to. */
export function watch(promise: Promise<unknown>): () => Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; });
  return async () => { await new Promise((resolve) => setImmediate(resolve)); return settled; };
}

/** A loopback port nothing listens on. */
export async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A new directory under the system's temporary one, removed with all it holds once `t` ends. Without `t`, it goes once the test that makes it ends, or the file's tests when made outside any test. */
export async function tempDir(prefix: string, t?: Pick<TestContext, "after">): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  (t?.after.bind(t) ?? after)(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Each file under `root`, with its bytes, mode, owner and modification time. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await Promise.all((await readdir(root, { recursive: true })).map(async (name) => {
    const s = await stat(join(root, name));
    return s.isDirectory() ? [] : [[name, `${(await readFile(join(root, name))).toString("base64")} ${(s.mode & 0o777).toString(8)} ${s.uid}:${s.gid} ${s.mtimeMs}`]];
  }));
  return Object.fromEntries(entries.flat());
}

/** An image manifest whose pins pass `pinsSchema`, so POST /v1/images takes it. */
export function testImage(over: Partial<ImageManifest> = {}): ImageManifest {
  return {
    id: "img-0123456789ab" as ImageId, gondolinBuildId: "b1", builtOn: "rj-firebat" as NodeName, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
    pins: {
      debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
      piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
      neovim: "0.12.6", neovimSha256: "b".repeat(64),
    },
    ...over,
  };
}

/** A node's capacity with nothing committed. */
export function testCapacity(over: Partial<NodeCapacity> = {}): NodeCapacity {
  return { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0, ...over };
}

export type RunningPylon = Extract<PylonObservation, { phase: "running" }>;
export type StoppedPylon = Extract<PylonObservation, { phase: "stopped" }>;

/** A pylon running img-000000000000 since 2027-01-01, with nothing read from it yet. */
export function runningPylon(pylonId: PylonId, over: Partial<Omit<RunningPylon, "pylonId" | "phase">> = {}): RunningPylon {
  return {
    pylonId, phase: "running", liveHash: null, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-000000000000" as ImageId, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0, ...over,
  };
}

export function stoppedPylon(pylonId: PylonId, over: Partial<Omit<StoppedPylon, "pylonId" | "phase">> = {}): StoppedPylon {
  return { pylonId, phase: "stopped", checkpoint: null, sessions: [], ...over };
}

/** A snapshot of `node` read now, by a probe that grants nothing and routes no preview. */
export function testObservation(node: NodeName, over: Partial<NodeObservation> = {}): NodeObservation {
  return {
    node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity: testCapacity(), artifacts: [], jobs: [], pylons: [],
    grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [], ...over,
  };
}

export interface CallOptions {
  host: string;
  port: number;
  method: string;
  path: string;
  /** Sent as is when a string, else as JSON. */
  body?: unknown;
  /** Overrides any header, so a test can pose as a browser page. */
  headers?: Record<string, string>;
}

/** Sends a request as the dashboard and CLI do, and reads the reply as text. */
export function callText({ host, port, method, path, body, headers = {} }: CallOptions): Promise<{ status: number; text: string }> {
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      // The servers under test share this event loop, so a pooled socket could be reused after its keep-alive expired.
      host, port, method, path, agent: false,
      // As fetch and the CLI do. Node frames a DELETE's body only with an explicit length.
      headers: { host: `${host}:${port}`, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }), ...headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, text }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

/** `callText`, with the reply parsed as JSON. An empty reply reads as null. */
export async function call(options: CallOptions): Promise<{ status: number; body: any }> {
  const { status, text } = await callText(options);
  return { status, body: text === "" ? null : JSON.parse(text) };
}
