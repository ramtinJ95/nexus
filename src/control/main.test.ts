import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { scriptedModel, scriptedModels } from "../harness/test-fixture.ts";
import { parseProbeConfig } from "../probe/config.ts";
import type { NodeName, ProbeClient, TailnetNodeId } from "../protocol.ts";
import { tokenDigest } from "../deploy/model.ts";
import { joinControlPlane } from "../deploy/setup.ts";
import { call as callJson, until } from "../test-kit.ts";
import { mintJoinToken } from "./join.ts";
import { parseConfig, startControlPlane } from "./main.ts";
import { openRegistry } from "./registry.ts";

const example = await readFile(new URL("../../deploy/control.example.json", import.meta.url), "utf8");
const probeExample = await readFile(new URL("../../deploy/probe.example.json", import.meta.url), "utf8");

test("the shipped example config parses", () => {
  const config = parseConfig(example);
  assert.deepEqual(config.harness.model, { provider: "openai", modelId: "gpt-6-astra" });
  assert.deepEqual(config.dotfiles, { repo: "https://github.com/example/dotfiles.git", ref: "main" });
});

test("a config without the harness, or with a relative harness path, is refused", () => {
  const { harness, ...rest } = JSON.parse(example);
  assert.throws(() => parseConfig(JSON.stringify(rest)), /harness/);
  assert.throws(() => parseConfig(JSON.stringify({ ...rest, harness: { ...harness, storage: "harness.sqlite" } })), /absolute path/);
});

test("no node may be named auto, which start --node auto asks for", () => {
  const config = JSON.parse(example);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, nodes: [{ ...config.nodes[0], name: "auto" }] })), /no node may be named it/);
});

test("a probe takes a node name exactly when the control plane does", () => {
  const config = JSON.parse(example);
  const probe = JSON.parse(probeExample);
  const parses = (parse: () => unknown) => { try { parse(); return true; } catch { return false; } };
  const plane = (name: string) => parses(() => parseConfig(JSON.stringify({ ...config, nodes: [{ ...config.nodes[0], name }] })));
  const node = (name: string) => parses(() => parseProbeConfig(JSON.stringify({ ...probe, node: name })));
  const names = ["infra-testbench", "a".repeat(63), "a".repeat(64), "auto", "-lead", "Upper"];
  for (const name of names) assert.equal(node(name), plane(name), name);
  assert.deepEqual(names.filter(plane), ["infra-testbench", "a".repeat(63)]);
});

test("preview ports default to 10200 to 10999, and a range that ends before it starts is refused", () => {
  const { previewPorts, ...rest } = JSON.parse(example);
  assert.deepEqual(previewPorts, { first: 10200, last: 10999 });
  assert.deepEqual(parseConfig(JSON.stringify(rest)).previewPorts, { first: 10200, last: 10999 });
  assert.throws(() => parseConfig(JSON.stringify({ ...rest, previewPorts: { first: 10300, last: 10200 } })), /first must not be above last/);
});

test("GitHub watching is opt-in and accepts only a token file path, never a token in config", () => {
  const config = JSON.parse(example);
  assert.equal(parseConfig(example).github, undefined);
  assert.deepEqual(parseConfig(JSON.stringify({ ...config, github: { tokenFile: "/etc/nexus/github-token" } })).github, { tokenFile: "/etc/nexus/github-token" });
  assert.throws(() => parseConfig(JSON.stringify({ ...config, github: { tokenFile: "relative" } })), /absolute path/);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, github: { token: "secret" } })), /invalid control plane config/);
});


test("HTTPS uses an allowed MagicDNS hostname and reserves 7443 from previews", () => {
  const config = JSON.parse(example);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, https: { hostname: "other.example.ts.net" } })), /listen.hostnames/);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, https: { hostname: "localhost" } })), /invalid/);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, previewPorts: { first: 7440, last: 7450 } })), /7443/);
});

test("git identity is optional and contains only a name and email", () => {
  const { gitIdentity, ...config } = JSON.parse(example);
  assert.deepEqual(parseConfig(example).gitIdentity, { name: "Example Person", email: "person@example.com" });
  assert.equal(parseConfig(JSON.stringify(config)).gitIdentity, undefined);
  for (const identity of [{ name: "", email: "person@example.com" }, { name: "Person", email: "not-email" }, { ...gitIdentity, token: "not-allowed" }, { name: "Person\nOther", email: "person@example.com" }]) {
    assert.throws(() => parseConfig(JSON.stringify({ ...config, gitIdentity: identity })), /invalid control plane config/);
  }
});

test("continuing after a usage limit is off unless the config turns it on", () => {
  const config = JSON.parse(example);
  assert.equal(parseConfig(example).resumeAfterUsageLimit, false);
  assert.equal(parseConfig(JSON.stringify({ ...config, resumeAfterUsageLimit: true })).resumeAfterUsageLimit, true);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, resumeAfterUsageLimit: "yes" })), /invalid control plane config/);
});

test("the image build node is optional, and one given must be a configured node", () => {
  const config = JSON.parse(example);
  assert.equal(parseConfig(example).imageBuildNode, undefined);
  const node = config.nodes[0].name;
  assert.equal(parseConfig(JSON.stringify({ ...config, imageBuildNode: node })).imageBuildNode, node);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, imageBuildNode: "elsewhere" })), /imageBuildNode elsewhere is not one of the nodes/);
});

/** A control plane as `main` starts it, on loopback, with a fake tailscaled and a fake probe for each node it follows. */
async function controlPlaneOf(t: import("node:test").TestContext, config: Record<string, unknown>, options: { before?: (db: string) => void; unaware?: readonly string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-main-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let caller: string | null = null;
  const hosts = new Map<string, string>();
  const socket = join(dir, "tailscaled.sock");
  const tailscaled = createServer((_req, res) => {
    if (caller === null) return res.writeHead(404).end();
    res.end(JSON.stringify({ Node: { StableID: caller, Name: `${hosts.get(caller) ?? "unnamed.example.ts.net"}.` } }));
  });
  await new Promise<void>((resolve) => tailscaled.listen(socket, resolve));
  t.after(() => new Promise<void>((resolve) => tailscaled.close(() => resolve())));
  const db = join(dir, "registry.db");
  options.before?.(db);

  const followed: [string, string, string][] = [];
  const peers = new Map<string, readonly string[]>();
  /** Nodes whose probe is from before peers were learned. */
  const unaware = new Set(options.unaware);
  const probe = (node: { name: NodeName; tailnetHost: string; tailnetNodeId: TailnetNodeId }): ProbeClient => {
    followed.push([node.name, node.tailnetHost, node.tailnetNodeId]);
    const unused = () => Promise.reject(new Error("unused"));
    return {
      node: node.name, submit: unused, job: unused, command: unused, stream: unused, manifest: unused, putSecret: unused, health: unused,
      async putPeers(list) {
        if (unaware.has(node.name)) throw new Error(`${node.name}: PUT /v1/peers: HTTP 404: no route /v1/peers`);
        peers.set(node.name, list);
      },
      async *observe(signal) {
        yield { type: "snapshot", observation: {
          events: [], node: node.name, observedAt: new Date().toISOString(), probeBootId: node.name, capacity: null, artifacts: [], jobs: [], pylons: [],
          previewRoutes: [], grants: { secrets: [], gitSsh: false }, heldSecrets: [],
        } };
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
    };
  };
  const plane = await startControlPlane(parseConfig(JSON.stringify({
    ...config, db, tailscaledSocket: socket,
    listen: { host: "127.0.0.1", port: 0, hostnames: ["127.0.0.1"] },
    harness: { storage: join(dir, "harness.sqlite"), credentials: join(dir, "harness-credentials.json"), model: scriptedModel },
  })), scriptedModels(), undefined, probe);
  t.after(() => plane.close());
  function call(as: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    caller = as;
    return callJson({ host: "127.0.0.1", port: plane.port, method, path, body, headers });
  }
  return { db, followed, peers, hosts, call, port: plane.port, as(id: string) { caller = id; } };
}

/** The person's control.json as install.sh wrote it before join tokens: two nodes, the Mac as caller and deployer, and both deploy keys. */
const today = {
  ...JSON.parse(example),
  deployers: ["nLaptopCNTRL"],
  deployKeys: { nControlPlaneCNTRL: tokenDigest("firebat-token"), nPeerProbeCNTRL: tokenDigest("bench-token") },
};
delete today.https;

test("a registry and control.json from before join tokens come up with the same nodes, callers, deployers and probe peers", async (t) => {
  const plane = await controlPlaneOf(t, today, { before: (db) => {
    const registry = openRegistry(db);
    registry.upsertNode({ name: "rj-firebat" as NodeName, tailnetHost: "rj-firebat.example.ts.net", tailnetNodeId: "nControlPlaneCNTRL" as TailnetNodeId });
    registry.upsertNode({ name: "infra-testbench" as NodeName, tailnetHost: "infra-testbench.example.ts.net", tailnetNodeId: "nPeerProbeCNTRL" as TailnetNodeId });
    registry.close();
    const raw = new DatabaseSync(db);
    const version = raw.prepare("PRAGMA user_version").get()!.user_version as number;
    raw.exec(`DROP TABLE join_tokens; DROP TABLE joined_nodes; PRAGMA user_version = ${version - 4}`);
    raw.close();
  } });
  assert.deepEqual(plane.followed, [
    ["rj-firebat", "rj-firebat.example.ts.net", "nControlPlaneCNTRL"],
    ["infra-testbench", "infra-testbench.example.ts.net", "nPeerProbeCNTRL"],
  ]);
  await until("both probes have their peers", () => plane.peers.size === 2);
  assert.deepEqual(Object.fromEntries(plane.peers), { "rj-firebat": ["nPeerProbeCNTRL"], "infra-testbench": ["nControlPlaneCNTRL"] }, "what --add-node and --node wrote to each probe.json's auth.peers");

  const whoami = [];
  for (const id of ["nLaptopCNTRL", "nControlPlaneCNTRL", "nPeerProbeCNTRL", "nStrangerCNTRL"]) whoami.push((await plane.call(id, "GET", "/v1/whoami")).body);
  assert.deepEqual(whoami, [
    { node: "nLaptopCNTRL", allowed: true, person: true, deployer: true },
    { node: "nControlPlaneCNTRL", allowed: true, person: false, deployer: false },
    { node: "nPeerProbeCNTRL", allowed: false, person: false, deployer: false },
    { node: "nStrangerCNTRL", allowed: false, person: false, deployer: false },
  ]);
  assert.deepEqual((await plane.call("nLaptopCNTRL", "GET", "/v1/nodes")).body.map((n: { name: string }) => n.name), ["infra-testbench", "rj-firebat"]);
  const report = { role: "probe", commit: null, target: null, state: "pending", reason: null };
  assert.equal((await plane.call("nPeerProbeCNTRL", "POST", "/v1/deployer/report", report, { authorization: "Bearer bench-token" })).status, 200, "control.json's deploy key");
  assert.equal((await plane.call("nPeerProbeCNTRL", "POST", "/v1/deployer/report", report, { authorization: "Bearer firebat-token" })).status, 403);
  const registry = openRegistry(plane.db);
  t.after(() => registry.close());
  assert.deepEqual(registry.joinedNodes(), []);
});

test("a machine that joins is followed without a restart, every probe learns it as a peer, and a probe that cannot learn peers keeps working", async (t) => {
  const plane = await controlPlaneOf(t, today, { unaware: ["infra-testbench"] });
  await until("rj-firebat has its peers", () => plane.peers.has("rj-firebat"));
  const registry = openRegistry(plane.db);
  t.after(() => registry.close());
  const { token } = mintJoinToken(registry);
  plane.hosts.set("nJoinerCNTRL", "infra-2.example.ts.net");
  const joined = await plane.call("nJoinerCNTRL", "POST", "/v1/join", { token, deployKey: tokenDigest("joiner-token"), name: "rj-firebat" });
  assert.deepEqual(joined, { status: 200, body: { node: "infra-2", tailnetNodeId: "nJoinerCNTRL" } });
  assert.deepEqual(plane.followed.at(-1), ["infra-2", "infra-2.example.ts.net", "nJoinerCNTRL"]);
  await until("the new probe has its peers", () => plane.peers.has("infra-2"));
  assert.deepEqual(Object.fromEntries(plane.peers), {
    "rj-firebat": ["nPeerProbeCNTRL", "nJoinerCNTRL"],
    "infra-2": ["nControlPlaneCNTRL", "nPeerProbeCNTRL"],
  }, "infra-testbench's probe answered 404, so it keeps probe.json's peers");
  await until("the new node is online", () => registry.node("infra-2" as NodeName)?.state === "online");
  assert.equal(registry.node("infra-testbench" as NodeName)?.state, "online");
  const report = { role: "probe", commit: null, target: null, state: "pending", reason: null };
  assert.equal((await plane.call("nJoinerCNTRL", "POST", "/v1/deployer/report", report, { authorization: "Bearer joiner-token" })).status, 200);
});

test("a node that joined is followed again after a restart, beside control.json's", async (t) => {
  const plane = await controlPlaneOf(t, today, { before: (db) => {
    const registry = openRegistry(db);
    const { token } = mintJoinToken(registry);
    registry.joinNode(tokenDigest(token), { name: "infra-2" as NodeName, tailnetHost: "infra-2.example.ts.net", tailnetNodeId: "nJoinerCNTRL" as TailnetNodeId, deployKey: tokenDigest("joiner-token") }, Date.now());
    registry.close();
  } });
  assert.deepEqual(plane.followed.map(([name]) => name), ["rj-firebat", "infra-testbench", "infra-2"]);
  await until("every probe has its peers", () => plane.peers.size === 3);
  assert.deepEqual(plane.peers.get("infra-testbench"), ["nControlPlaneCNTRL", "nJoinerCNTRL"]);
});

test("the installer's join reaches only the control plane deployer.json names, and says why one is refused", async (t) => {
  const plane = await controlPlaneOf(t, today);
  const registry = openRegistry(plane.db);
  t.after(() => registry.close());
  const { token } = mintJoinToken(registry);
  plane.hosts.set("nJoinerCNTRL", "infra-2.example.ts.net");
  plane.as("nJoinerCNTRL");
  const deployer = { controlUrl: `http://127.0.0.1:${plane.port}/`, controlNodeId: "nControlPlaneCNTRL", token: "joiner-token" };
  await assert.rejects(joinControlPlane(deployer, token, async () => "nImpostorCNTRL" as TailnetNodeId), /did not take the join: deployment endpoint has the wrong tailnet identity/);
  assert.deepEqual(registry.joinedNodes(), [], "the impostor got nothing");
  assert.equal(await joinControlPlane(deployer, token, async () => "nControlPlaneCNTRL" as TailnetNodeId), "infra-2");
  assert.equal(registry.joinedNodes()[0]?.deployKey, tokenDigest("joiner-token"));
  await assert.rejects(joinControlPlane(deployer, token, async () => "nControlPlaneCNTRL" as TailnetNodeId), new RegExp(`^Error: the control plane at http://127\\.0\\.0\\.1:${plane.port}/ did not take the join: this join token was used at `));
});

test("the host command mints a join token only as root", { skip: process.getuid?.() === 0 && "this test runs as root" }, async () => {
  const run = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./join-token.ts", import.meta.url)), "/etc/nexus/control.json"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(run.code, 77);
  assert.match(run.stderr, /run this as root on the control plane's machine\. A join token adds a node, so only root may mint one/);
});

test("a node that joined and was then added to control.json never joins again, and the token it sends stays unused", async (t) => {
  const infra2 = { name: "infra-2", tailnetHost: "infra-2.example.ts.net", tailnetNodeId: "nJoinerCNTRL" };
  const plane = await controlPlaneOf(t, { ...today, nodes: [...today.nodes, infra2], deployKeys: { ...today.deployKeys, nJoinerCNTRL: tokenDigest("config-token") } }, { before: (db) => {
    const registry = openRegistry(db);
    const { token } = mintJoinToken(registry);
    registry.joinNode(tokenDigest(token), { ...infra2, name: "infra-2" as NodeName, tailnetNodeId: "nJoinerCNTRL" as TailnetNodeId, deployKey: tokenDigest("joiner-token") }, Date.now());
    registry.close();
  } });
  const registry = openRegistry(plane.db);
  t.after(() => registry.close());
  const { token } = mintJoinToken(registry);
  plane.hosts.set("nJoinerCNTRL", "infra-2.example.ts.net");
  assert.deepEqual(await plane.call("nJoinerCNTRL", "POST", "/v1/join", { token, deployKey: tokenDigest("another-token") }), { status: 409, body: { error: "infra-2.example.ts.net is a node in control.json, which sets its deploy key" } });
  assert.equal(registry.joinToken(tokenDigest(token))?.usedAt, null);
  assert.equal(registry.joinedNodes()[0]?.deployKey, tokenDigest("joiner-token"), "the refused join replaced nothing");
});
