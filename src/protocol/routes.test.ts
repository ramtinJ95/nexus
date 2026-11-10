import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { JobId, NodeName, PortableArtifactId, PylonId, TailnetNodeId } from "../ids.ts";
import { connectProbe } from "./client.ts";
import { fetchArtifact } from "./artifacts.ts";
import { probeRoutes, routeRole } from "./routes.ts";
import { routePath } from "../util/route-path.ts";

/** Each (method, path) client.ts and artifacts.ts spelled out, with the role routeAuth gave its prefix, before the table. */
const before = [
  ["PUT", "/v1/jobs/{jobId}", "control-plane"],
  ["GET", "/v1/jobs/{jobId}", "control-plane"],
  ["GET", "/v1/observe", "control-plane"],
  ["POST", "/v1/pylons/{pylonId}/commands", "control-plane"],
  ["POST", "/v1/pylons/{pylonId}/git", "control-plane"],
  ["GET", "/v1/pylons/{pylonId}/stream", "control-plane"],
  ["GET", "/v1/manifests/{artifact}", "control-plane"],
  ["PUT", "/v1/secrets/{name}", "control-plane"],
  ["PUT", "/v1/peers", "control-plane"],
  ["GET", "/v1/node-health", "control-plane"],
  ["GET", "/v1/cleanup", "control-plane"],
  ["POST", "/v1/cleanup", "control-plane"],
  ["POST", "/v1/deployer/wake", "control-plane"],
  ["GET", "/v1/artifacts/{artifact}", "peer-probe"],
] as const;
const routeAuthBefore = {
  "/v1/jobs": "control-plane", "/v1/observe": "control-plane", "/v1/pylons": "control-plane", "/v1/manifests": "control-plane", "/v1/secrets": "control-plane",
  "/v1/peers": "control-plane", "/v1/node-health": "control-plane", "/v1/cleanup": "control-plane", "/v1/deployer": "control-plane", "/v1/artifacts": "peer-probe",
} as const;

const routes = Object.values(probeRoutes);
const matches = (template: string, path: string) => new RegExp(`^${template.replace(/\{\w+\}/g, "[^/]+")}$`).test(path);

test("the route table holds every (method, path, role) the client used and routeAuth allowed, and nothing else", () => {
  assert.deepEqual(routes.map((r) => [r.method, r.path, r.role]).sort(), before.map((r) => [...r]).sort());
  for (const [method, path, role] of before) assert.equal(routeAuthBefore[path.split("/").slice(0, 3).join("/") as keyof typeof routeAuthBefore], role, `${method} ${path}`);
});

test("a path takes the role routeAuth gave its prefix, and a path under no prefix takes none", () => {
  for (const [prefix, role] of Object.entries(routeAuthBefore)) {
    assert.equal(routeRole(prefix), role, prefix);
    assert.equal(routeRole(`${prefix}/anything/below`), role, `below ${prefix}`);
  }
  for (const path of ["/", "/v1", "/v1/", "/v1/health", "/v1/jobsx", "/v2/jobs", "/jobs/v1/jobs"]) assert.equal(routeRole(path), undefined, path);
});

test("a route's path encodes each parameter, and only the stream upgrades and only submit retries", () => {
  assert.equal(routePath(probeRoutes.job, { jobId: "a/b c" }), "/v1/jobs/a%2Fb%20c");
  assert.equal(routePath(probeRoutes.putPeers), "/v1/peers");
  // @ts-expect-error a route with a parameter needs it
  assert.throws(() => routePath(probeRoutes.job), /needs jobId/);
  const either = probeRoutes.job as typeof probeRoutes.job | typeof probeRoutes.command;
  // @ts-expect-error a union of routes cannot say which parameters it needs
  assert.throws(() => routePath(either), /needs/);
  // @ts-expect-error even given one route's parameters
  routePath(either, { jobId: "job-1" });
  const mixed = probeRoutes.job as typeof probeRoutes.job | typeof probeRoutes.putPeers;
  // @ts-expect-error nor when only some of its routes have parameters
  assert.throws(() => routePath(mixed), /needs/);
  const widened: { path: string } = probeRoutes.putPeers;
  // @ts-expect-error a widened path names no parameters to require
  routePath(widened);
  assert.deepEqual(routes.filter((r) => "upgrade" in r).map((r) => [r.path, r.upgrade]), [["/v1/pylons/{pylonId}/stream", "nexus-stream"]]);
  assert.deepEqual(routes.filter((r) => "retry" in r).map((r) => [r.method, r.path, r.retry]), [["PUT", "/v1/jobs/{jobId}", "until-expired"]]);
});

test("each call the client and an artifact fetch make is a route in the table, with the upgrade the table names", async (t) => {
  const seen: { method: string; path: string; upgrade: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method!, path: new URL(req.url!, "http://probe").pathname, upgrade: req.headers.upgrade });
    req.resume().on("end", () => res.writeHead(599).end("recorded"));
  }).listen(0, "127.0.0.1");
  await new Promise((ready) => server.once("listening", ready));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const whois = async () => "nPROBE" as TailnetNodeId;
  const client = connectProbe("test-node" as NodeName, "127.0.0.1", "nPROBE" as TailnetNodeId, { port, whois });
  const pylonId = "pylon-th-1" as PylonId;
  const artifact = "img-abc123" as PortableArtifactId;
  const notAfter = new Date(Date.now() - 1000).toISOString();
  const calls: Promise<unknown>[] = [
    client.submit({ jobId: "job-1" as JobId, node: "test-node" as NodeName, issuedAt: notAfter, notAfter, job: { kind: "delete", pylonId } }),
    client.job("job-1" as JobId),
    (async () => { for await (const _ of client.observe(AbortSignal.timeout(60_000))) break; })(),
    client.command(pylonId, { kind: "exec", argv: ["true"] } as never),
    client.readGit(pylonId),
    client.stream(pylonId, ["cat"]),
    client.manifest(artifact),
    client.putSecret("GH_TOKEN", "x"),
    client.putPeers([]),
    client.health(),
    client.artifactUsage(),
    client.dropArtifacts([artifact]),
    client.wakeDeployer(),
    fetchArtifact({ host: "127.0.0.1", port }, artifact, "0".repeat(64), { whois, peers: ["nPROBE" as TailnetNodeId] }, AbortSignal.timeout(60_000)),
  ];
  await Promise.allSettled(calls);
  assert.equal(seen.length, routes.length, "one request per route");
  for (const { method, path, upgrade } of seen) {
    const route = routes.find((r) => r.method === method && matches(r.path, path) && ("upgrade" in r ? r.upgrade : undefined) === upgrade);
    assert.ok(route !== undefined, `${method} ${path} upgrade ${upgrade}`);
  }
  assert.deepEqual(new Set(seen.map(({ method, path }) => routes.find((r) => r.method === method && matches(r.path, path)))).size, routes.length, "every route was called");
});
