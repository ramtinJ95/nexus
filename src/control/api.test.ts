/** The API server's core: who may call it, joins, whoami, health, TLS, its body limit, unknown routes and its route table. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { featureRoutes, type ApiOptions } from "./api.ts";
import type { ApiKit } from "./api/kit.ts";
import { version } from "../version.ts";
import type { QueuedThread } from "./queue.ts";
import type { ReviewLoop } from "./review.ts";
import { joinTokenTtlMs, mintJoinToken } from "./join.ts";
import type { ProjectId } from "../ids.ts";
import { tokenDigest } from "../deploy/model.ts";
import { until } from "../test-kit.ts";
import type { NodeName, TailnetNodeId } from "../ids.ts";
import { node, laptop, phone, project, dir, testApi, withThread, attachTo, attached, attachPathOf, deployCommit, deployment, reporterHeaders, withQueue } from "./api-test-kit.ts";

test("callers off the allowlist, or unknown to tailscaled, are refused", async (t) => {
  const s = await testApi(t);
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.call("GET", "/v1/projects")).status, 403);
  s.callAs(null);
  assert.equal((await s.call("GET", "/v1/projects")).status, 403);
  s.callAs(laptop);
  assert.deepEqual(await s.call("GET", "/v1/projects"), { status: 200, body: [] });
});

test("a path that does not decode is a 400 to an allowed caller and a 403 to any other, and a Host that does not parse is a 403", async (t) => {
  const s = await testApi(t);
  const bad = await s.call("GET", "/v1/%zz");
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.body.error, "string");
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.deepEqual(await s.call("GET", "/v1/%zz"), { status: 403, body: { error: "caller is not a tailnet node this control plane allows" } });
  s.callAs(laptop);
  for (const host of ["[zz", "a b"]) {
    assert.deepEqual(await s.call("GET", "/v1/projects", undefined, { host }), { status: 403, body: { error: `the API does not answer to host ${host}` } }, host);
    assert.equal((await s.call("GET", "/v1/whoami", undefined, { host })).status, 403, `whoami under ${host}`);
  }
});

test("any tailnet node may ask who it is and what it may do, under the API's names only", async (t) => {
  const s = await testApi(t, { deployment });
  const asks: [string, string][] = [[laptop, "a deployer"], [phone, "a person"], ["nFIREBAT", "the control node, though listed as a deployer"], ["nSTRANGER", "a stranger"]];
  const answers = [];
  for (const [id] of asks) {
    s.callAs(id as TailnetNodeId);
    answers.push((await s.call("GET", "/v1/whoami")).body);
  }
  assert.deepEqual(answers, [
    { node: laptop, allowed: true, person: true, deployer: true },
    { node: phone, allowed: true, person: true, deployer: false },
    { node: "nFIREBAT", allowed: true, person: false, deployer: false },
    { node: "nSTRANGER", allowed: false, person: false, deployer: false },
  ], asks.map(([, who]) => who).join(", "));
  assert.deepEqual(await s.call("GET", "/v1/whoami", undefined, { host: "evil.example" }), { status: 403, body: { error: "the API does not answer to host evil.example" } });
  assert.deepEqual(await s.call("GET", "/v1/projects"), { status: 403, body: { error: "caller is not a tailnet node this control plane allows" } }, "it opens no other route to a stranger");
  s.callAs(null);
  assert.deepEqual(await s.call("GET", "/v1/whoami"), { status: 403, body: { error: "caller is not a tailnet node" } });
});

const joinerKey = "b".repeat(64);
const joiner = "nJOINER" as TailnetNodeId;

test("a machine joins once with a token, as whois names it, whatever its request says", async (t) => {
  const s = await testApi(t);
  const { token } = mintJoinToken(s.registry);
  s.callAs(joiner);
  s.hosts.set(joiner, "infra-2.tail.ts.net");
  const forged = { token, deployKey: joinerKey, name: "rj-firebat", node: "rj-firebat", tailnetNodeId: laptop, tailnetHost: "evil.example" };
  assert.deepEqual(await s.call("POST", "/v1/join", forged), { status: 200, body: { node: "infra-2", tailnetNodeId: joiner } });
  const recorded = { name: "infra-2", tailnetHost: "infra-2.tail.ts.net", tailnetNodeId: joiner, deployKey: joinerKey };
  assert.deepEqual(s.registry.joinedNodes().map(({ joinedAt: _, ...n }) => n), [recorded]);
  assert.deepEqual(s.joined.map(({ joinedAt: _, ...n }) => n), [recorded], "the control plane is told, so it follows the new probe");
  assert.deepEqual(s.registry.nodes().map((n) => [n.name, n.tailnetNodeId]), [["infra-2", joiner], ["rj-firebat", "nFIREBAT"]], "rj-firebat is as it was");

  s.callAs("nSECOND" as TailnetNodeId);
  s.hosts.set("nSECOND" as TailnetNodeId, "infra-3.tail.ts.net");
  const used = await s.call("POST", "/v1/join", { token, deployKey: joinerKey });
  assert.equal(used.status, 403);
  assert.match(used.body.error, /^this join token was used at .*, and each joins one node\. Mint another with sudo deploy\/install\.sh --join-token/);
  assert.deepEqual(s.registry.joinedNodes().map((n) => n.name), ["infra-2"], "a used token records nothing");
});

test("an unknown or expired token is refused with nothing recorded", async (t) => {
  const s = await testApi(t);
  const expired = mintJoinToken(s.registry, Date.now() - joinTokenTtlMs - 1).token;
  s.callAs(joiner);
  s.hosts.set(joiner, "infra-2.tail.ts.net");
  const unknown = await s.call("POST", "/v1/join", { token: "not-minted", deployKey: joinerKey });
  assert.deepEqual(unknown, { status: 403, body: { error: "this join token is not one this control plane minted. Mint another with sudo deploy/install.sh --join-token on the control plane's machine" } });
  const late = await s.call("POST", "/v1/join", { token: expired, deployKey: joinerKey });
  assert.equal(late.status, 403);
  assert.match(late.body.error, /^this join token expired at \d{4}-/);
  assert.equal((await s.call("POST", "/v1/join", { token: expired })).status, 400, "a join names its deploy key");
  assert.deepEqual([s.registry.joinedNodes(), s.joined, s.registry.nodes().map((n) => n.name)], [[], [], ["rj-firebat"]]);
});

test("a caller, the control plane's machine and a node of control.json never join, and a token they send stays unused", async (t) => {
  const s = await testApi(t);
  s.registry.upsertNode({ name: "infra-testbench" as NodeName, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: "nBENCH" as TailnetNodeId });
  s.registry.upsertNode({ name: "retired" as NodeName, tailnetHost: "retired.tail.ts.net", tailnetNodeId: "nRETIRED" as TailnetNodeId });
  const { token } = mintJoinToken(s.registry);
  const attempts: [TailnetNodeId, string][] = [
    [laptop, "laptop.tail.ts.net"],
    ["nFIREBAT" as TailnetNodeId, "rj-firebat.tail.ts.net"],
    ["nBENCH" as TailnetNodeId, "infra-testbench.tail.ts.net"],
    ["nIMPOSTOR" as TailnetNodeId, "infra-testbench.tail.ts.net"],
    ["nBENCH" as TailnetNodeId, "renamed.tail.ts.net"],
    ["nRETIRED" as TailnetNodeId, "renamed.tail.ts.net"],
    ["nUPPER" as TailnetNodeId, "Upper.tail.ts.net"],
  ];
  const answers = [];
  for (const [id, host] of attempts) {
    s.callAs(id);
    s.hosts.set(id, host);
    const reply = await s.call("POST", "/v1/join", { token, deployKey: joinerKey });
    answers.push(`${reply.status} ${reply.body.error}`);
  }
  assert.deepEqual(answers, [
    "409 laptop.tail.ts.net is the control plane's machine or a caller in control.json, which never joins as a node",
    "409 rj-firebat.tail.ts.net is the control plane's machine or a caller in control.json, which never joins as a node",
    "409 infra-testbench.tail.ts.net is a node in control.json, which sets its deploy key",
    "409 a node named infra-testbench is already tailnet node nBENCH. Rename this machine in tailscale",
    "409 renamed.tail.ts.net is a node in control.json, which sets its deploy key",
    "409 this machine is already the node retired, and tailscale now names it renamed",
    "409 tailscale names this machine Upper.tail.ts.net, whose first label is not a node name: must be a lowercase tailnet machine name of at most 63 characters",
  ]);
  assert.equal(s.registry.joinToken(tokenDigest(token))?.usedAt, null);
  s.callAs(joiner);
  s.hosts.set(joiner, "infra-2.tail.ts.net");
  assert.equal((await s.call("POST", "/v1/join", { token, deployKey: joinerKey })).status, 200, "the token still joins a new machine");
});

test("a joined node joins again with a new token, which replaces its deploy key, and reports with it", async (t) => {
  const s = await testApi(t, { deployment });
  s.callAs(joiner);
  s.hosts.set(joiner, "infra-2.tail.ts.net");
  const report = { role: "probe", commit: deployCommit, target: deployCommit, state: "healthy", reason: null };
  assert.equal((await s.call("POST", "/v1/join", { token: mintJoinToken(s.registry).token, deployKey: tokenDigest("first") })).status, 200);
  assert.equal((await s.call("POST", "/v1/deployer/report", report, { authorization: "Bearer first" })).status, 200);
  assert.equal((await s.call("POST", "/v1/join", { token: mintJoinToken(s.registry).token, deployKey: tokenDigest("second") })).status, 200);
  assert.equal((await s.call("POST", "/v1/deployer/report", report, { authorization: "Bearer first" })).status, 403);
  assert.equal((await s.call("POST", "/v1/deployer/report", report, { authorization: "Bearer second" })).status, 200);
  assert.deepEqual((await s.call("GET", "/v1/whoami")).body, { node: joiner, allowed: false, person: false, deployer: false });
});

test("a machine neither admitted nor joined reaches only whoami and join, and a joined node only its deployer's routes", async (t) => {
  const s = await withThread(t, { deployment });
  const thread = s.thread.id;
  s.callAs(joiner);
  s.hosts.set(joiner, "infra-2.tail.ts.net");
  const requests: [string, string, unknown?, Record<string, string>?][] = [
    ["GET", "/"],
    ["GET", "/threads"],
    ["GET", `/threads/${thread}`],
    ["GET", "/v1/projects"],
    ["POST", "/v1/projects", project],
    ["GET", "/v1/threads"],
    ["POST", "/v1/threads", { project: project.id, title: "Mine" }],
    ["GET", `/v1/threads/${thread}`],
    ["POST", `/v1/threads/${thread}/messages`, { text: "hi" }],
    ["GET", "/v1/nodes"],
    ["GET", `/v1/nodes/${node}/health`],
    ["GET", "/v1/images"],
    ["PUT", "/v1/release", { commit: "main" }],
    ["GET", "/v1/events"],
    ["GET", "/v1/usage"],
    ["GET", "/v1/health?past=admission"],
    ["GET", "/v1/deployer/release", undefined, { authorization: "Bearer joiner" }],
    ["POST", "/v1/deployer/report", { role: "probe", commit: deployCommit, target: deployCommit, state: "healthy", reason: null }, { authorization: "Bearer joiner" }],
  ];
  const sweep = async () => {
    const statuses = [];
    for (const [method, path, body, headers] of requests) statuses.push(`${method} ${path} ${(await s.call(method, path, body, headers)).status}`);
    statuses.push(`attach ${(await attachTo(s.port, attachPathOf(thread)) as { status: number }).status}`);
    return statuses;
  };
  const refused = [...requests.map(([method, path]) => `${method} ${path} 403`), "attach 403"];
  assert.deepEqual(await sweep(), refused, "before it joins");
  assert.equal((await s.call("GET", "/v1/whoami")).status, 200);
  assert.equal((await s.call("POST", "/v1/join", { token: mintJoinToken(s.registry).token, deployKey: tokenDigest("joiner") })).status, 200);
  assert.deepEqual(await sweep(), [...refused.slice(0, -3), "GET /v1/deployer/release 200", "POST /v1/deployer/report 200", "attach 403"], "once it joined");
});

test("a web page on an allowed machine cannot change state", async (t) => {
  const s = await testApi(t);
  // A cross-origin form or fetch without a preflight can only send a simple content type.
  const forged = await s.call("POST", "/v1/projects", JSON.stringify(project), { "content-type": "text/plain" });
  assert.equal(forged.status, 415);
  // A DNS rebinding page reaches the API under the page's own name.
  assert.equal((await s.call("GET", "/v1/projects", undefined, { host: "evil.example:80" })).status, 403);
  assert.equal((await s.call("POST", "/v1/projects", project, { host: "evil.example" })).status, 403);
  assert.deepEqual(s.registry.projects(), []);
});

test("unknown threads, routes and methods get 404 and 405", async (t) => {
  const s = await testApi(t);
  assert.equal((await s.call("GET", "/v1/threads/th-missing")).status, 404);
  assert.equal((await s.call("GET", "/v1/nothing")).status, 404);
  assert.equal((await s.call("PATCH", "/v1/projects")).status, 405);
  assert.equal((await s.call("POST", "/v1/projects", undefined)).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", "{not json")).status, 400);
});

test("pylon traffic under its host identity cannot deploy even if that identity is allowed and listed as a deployer", async (t) => {
  const s = await testApi(t, { deployment });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("PUT", "/v1/release", { commit: deployCommit }, { "x-forwarded-for": "nLAPTOP", ...reporterHeaders })).status, 403);
  assert.equal((await s.call("GET", "/v1/deployer/release")).status, 403);
  assert.equal((await s.call("GET", "/v1/%64eployer/release")).status, 403);
  assert.equal((await s.call("POST", "/v1/%64eployer/drain", { commit: deployCommit })).status, 403);
  assert.equal((await s.call("GET", "/v1/deployer/release", undefined, reporterHeaders)).status, 200);
  s.callAs(null);
  assert.equal((await s.call("PUT", "/v1/release", { commit: deployCommit }, reporterHeaders)).status, 403);
});

test("a body over a mebibyte is refused with 413 and reaches no route", async (t) => {
  const s = await testApi(t);
  const refused = await s.call("POST", "/v1/projects", "x".repeat((1 << 20) + 1));
  assert.equal(refused.status, 413);
  assert.deepEqual(refused.body, { error: "request body over 1048576 bytes" });
  assert.deepEqual(s.registry.projects(), []);
});


test("direct TLS uses TCP whois, ignores forged headers, and renews without disturbing HTTP", async (t) => {
  const { testCertificate } = await import("../test-certificate.ts");
  const { request: tlsRequest } = await import("node:https");
  const { X509Certificate } = await import("node:crypto");
  const certDir = await mkdtemp(join(dir, "tls-"));
  const first = await testCertificate(certDir);
  const second = await testCertificate(certDir);
  assert.notEqual(new X509Certificate(first.cert).subject, new X509Certificate(second.cert).subject);
  let current = first;
  let fail = false;
  let reads = 0;
  const api = await testApi(t, {
    https: { port: 0, renewalMs: 25, retryMs: 10, certificate: async () => {
      reads++;
      if (fail) throw new Error("renewal unavailable");
      return current;
    } },
    deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
  });
  function tls(path = "/v1/threads", headers: Record<string, string> = {}, method = "GET") {
    return new Promise<{ status: number; fingerprint: string }>((resolve, reject) => {
      const req = tlsRequest({
        hostname: "127.0.0.1", port: api.httpsPort, path, method, agent: false,
        ca: [first.cert, second.cert], servername: "dashboard.example.ts.net",
        headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
      }, (res) => {
        const fingerprint = (res.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256;
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode!, fingerprint }));
      });
      req.on("error", reject).end();
    });
  }
  await until("HTTPS started", () => api.httpsPort !== undefined);
  assert.equal((await tls()).status, 200);
  assert.equal((await tls()).fingerprint, new X509Certificate(first.cert).fingerprint256);
  assert.equal((await api.call("GET", "/v1/threads")).status, 200);
  api.callAs(null);
  const forged = { "x-forwarded-for": "100.64.0.10", "x-forwarded-host": "127.0.0.1", "tailscale-user-login": "owner@example.com" };
  assert.equal((await tls("/v1/threads", forged)).status, 403);
  assert.equal((await api.call("GET", "/v1/threads", undefined, forged)).status, 403);
  api.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await tls("/v1/release", forged, "PUT")).status, 403);
  api.callAs(laptop);
  assert.equal((await tls("/v1/threads", { ...forged, host: "evil.example" })).status, 403);
  const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
  assert.equal((await tls(attachPathOf("missing"), { ...upgrade, origin: "https://127.0.0.1" })).status, 404);
  assert.equal((await tls(attachPathOf("missing"), { ...upgrade, origin: "http://127.0.0.1" })).status, 403);
  assert.equal((await tls(attachPathOf("missing"), { ...upgrade, origin: "https://127.0.0.1:10200" })).status, 403);
  fail = true;
  const before = reads;
  await until("the renewal read the certificate", () => reads !== before);
  assert.equal((await tls()).fingerprint, new X509Certificate(first.cert).fingerprint256);
  assert.equal((await api.call("GET", "/v1/health")).body.https.status, "degraded");
  fail = false;
  current = second;
  for (const deadline = Date.now() + 60_000; (await tls()).fingerprint !== new X509Certificate(second.cert).fingerprint256;) {
    assert.ok(Date.now() < deadline, "certificate renewed");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await api.call("GET", "/v1/threads")).status, 200);
});

test("health reports the version of the API contract, which the CLI reads", async (t) => {
  const api = await testApi(t);
  assert.equal((await api.call("GET", "/v1/health")).body.version, version);
});

test("HTTP starts while certificate issuance is pending, survives failure, and HTTPS starts on retry", async (t) => {
  const { testCertificate } = await import("../test-certificate.ts");
  const { request: tlsRequest } = await import("node:https");
  const certificate = await testCertificate(await mkdtemp(join(dir, "startup-tls-")));
  const first = Promise.withResolvers<typeof certificate>();
  const retry = Promise.withResolvers<typeof certificate>();
  let attempts = 0;
  const api = await testApi(t, { https: { port: 0, retryMs: 10, certificate: () => ++attempts === 1 ? first.promise : retry.promise } });
  assert.equal((await api.call("GET", "/v1/threads")).status, 200);
  assert.equal(api.httpsPort, undefined);
  assert.deepEqual((await api.call("GET", "/v1/health")).body.https, { status: "waiting", error: null, nextAttemptAt: null });
  first.reject(new Error("tailscaled certificate: HTTP 403"));
  await until("issuance retried", () => attempts >= 2);
  const failed = await api.call("GET", "/v1/health");
  assert.equal(failed.status, 200);
  assert.equal(failed.body.https.status, "waiting");
  assert.equal(failed.body.https.error, "tailscaled certificate: HTTP 403");
  assert.equal((await api.call("GET", "/v1/threads")).status, 200);
  retry.resolve(certificate);
  await until("HTTPS started after retry", () => api.httpsPort !== undefined);
  const ready = (await api.call("GET", "/v1/health")).body.https;
  assert.equal(ready.status, "ready");
  assert.equal(ready.error, null);
  assert.ok(ready.nextAttemptAt > Date.now());
  assert.equal(await new Promise<number>((resolve, reject) => {
    tlsRequest({ hostname: "127.0.0.1", port: api.httpsPort, path: "/v1/threads", ca: certificate.cert, servername: "dashboard.example.ts.net" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    }).on("error", reject).end();
  }), 200);
  assert.equal((await api.call("GET", "/v1/threads")).status, 200);
});

test("closing HTTP while issuance is pending prevents a late HTTPS listener", async (t) => {
  const { testCertificate } = await import("../test-certificate.ts");
  const certificate = await testCertificate(await mkdtemp(join(dir, "late-tls-")));
  const pending = Promise.withResolvers<typeof certificate>();
  const api = await testApi(t, { https: { port: 0, certificate: () => pending.promise } });
  await api.close();
  pending.resolve(certificate);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(api.httpsPort, undefined);
});

test("the health, release, deployer and event routes answer each caller and method as listed", async (t) => {
  const report = { role: "probe", commit: deployCommit, target: deployCommit, state: "healthy", reason: null };
  const off = await testApi(t);
  const otherToken = "other-node-token";
  const on = await testApi(t, { deployment: { ...deployment, keys: { ...deployment.keys, nOTHER: tokenDigest(otherToken) } } });
  on.registry.upsertNode({ name: "rj-other" as NodeName, tailnetHost: "rj-other.tail.ts.net", tailnetNodeId: "nOTHER" as TailnetNodeId });
  const notDeployer = await testApi(t, { deployment: { ...deployment, deployers: new Set(["nFIREBAT" as TailnetNodeId]) } });
  const callers: [string, Awaited<ReturnType<typeof testApi>>, string, Record<string, string>][] = [
    ["a deployer", on, laptop, {}],
    ["an allowed caller who is not a deployer", notDeployer, laptop, {}],
    ["an allowed caller while deploys are off", off, laptop, {}],
    ["the control node", on, "nFIREBAT", {}],
    ["the control node with its deployer key", on, "nFIREBAT", reporterHeaders],
    ["the control node with another key", on, "nFIREBAT", { authorization: "Bearer not-the-key" }],
    ["an allowed laptop with the control node's key", on, laptop, reporterHeaders],
    ["another node with its deployer key", on, "nOTHER", { authorization: `Bearer ${otherToken}` }],
    ["a stranger", on, "nSTRANGER", {}],
    ["a stranger with the control node's key", on, "nSTRANGER", reporterHeaders],
  ];
  const requests: [string, string, unknown?][] = [
    ["GET", "/v1/health?past=admission"],
    ["POST", "/v1/health", {}],
    ["GET", "/v1/release"],
    ["PUT", "/v1/release", { commit: "main" }],
    ["PUT", "/v1/release", { commit: "--evil" }],
    ["POST", "/v1/release", { commit: "main" }],
    ["GET", "/v1/deployer/release"],
    ["POST", "/v1/deployer/release", {}],
    ["POST", "/v1/deployer/report", report],
    ["POST", "/v1/deployer/report", { ...report, role: "control" }],
    ["POST", "/v1/deployer/report", { ...report, state: "fine" }],
    ["GET", "/v1/deployer/report"],
    ["POST", "/v1/deployer/drain", { commit: "b".repeat(40) }],
    ["POST", "/v1/deployer/drain", { commit: deployCommit, release: true }],
    ["GET", "/v1/deployer/drain"],
    ["POST", "/v1/deployer/nothing", {}],
    ["GET", "/v1/deployer/nothing"],
    ["GET", "/v1/events?kind=release.changed"],
    ["GET", "/v1/events?since=-1"],
    ["GET", "/v1/events?kind=unknown"],
    ["DELETE", "/v1/events"],
  ];
  const answers: Record<string, string[]> = {};
  for (const [who, s, id, headers] of callers) {
    s.callAs(id as TailnetNodeId);
    answers[who] = [];
    for (const [method, path, body] of requests) {
      const reply = await s.call(method, path, body, headers);
      answers[who].push(`${method} ${path} ${reply.status}${reply.status < 300 ? "" : ` ${reply.body.error}`}`);
    }
  }
  const deployer = [
    "GET /v1/health?past=admission 200",
    "POST /v1/health 405 POST is not allowed on /v1/health",
    "GET /v1/release 200",
    "PUT /v1/release 200",
    "PUT /v1/release 400 ✖ Invalid string: must match pattern /^[0-9a-f]{40}$/\n  → at commit",
    "POST /v1/release 405 POST is not allowed on /v1/release",
    "GET /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?kind=release.changed 200",
    "GET /v1/events?since=-1 400 invalid event cursor",
    "GET /v1/events?kind=unknown 400 unknown event kind",
    "DELETE /v1/events 405 DELETE is not allowed on /v1/events",
  ];
  const allowed = [
    "GET /v1/health?past=admission 200",
    "POST /v1/health 405 POST is not allowed on /v1/health",
    "GET /v1/release 200",
    "PUT /v1/release 403 caller may not deploy; infrastructure nodes and pylons cannot deploy",
    "PUT /v1/release 403 caller may not deploy; infrastructure nodes and pylons cannot deploy",
    "POST /v1/release 405 POST is not allowed on /v1/release",
    "GET /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?kind=release.changed 200",
    "GET /v1/events?since=-1 400 invalid event cursor",
    "GET /v1/events?kind=unknown 400 unknown event kind",
    "DELETE /v1/events 405 DELETE is not allowed on /v1/events",
  ];
  const controlKey = [
    "GET /v1/health?past=admission 200",
    "POST /v1/health 405 POST is not allowed on /v1/health",
    "GET /v1/release 200",
    "PUT /v1/release 403 caller may not deploy; infrastructure nodes and pylons cannot deploy",
    "PUT /v1/release 403 caller may not deploy; infrastructure nodes and pylons cannot deploy",
    "POST /v1/release 405 POST is not allowed on /v1/release",
    "GET /v1/deployer/release 200",
    "POST /v1/deployer/release 405 POST is not allowed on /v1/deployer/release",
    "POST /v1/deployer/report 200",
    "POST /v1/deployer/report 200",
    "POST /v1/deployer/report 400 ✖ Invalid option: expected one of \"pending\"|\"waiting-for-control\"|\"waiting-for-idle\"|\"installing\"|\"healthy\"|\"rolled-back\"|\"failed\"\n  → at state",
    "GET /v1/deployer/report 405 GET is not allowed on /v1/deployer/report",
    "POST /v1/deployer/drain 409 release was superseded",
    "POST /v1/deployer/drain 200",
    "GET /v1/deployer/drain 405 GET is not allowed on /v1/deployer/drain",
    "POST /v1/deployer/nothing 404 no deployer route /v1/deployer/nothing",
    "GET /v1/deployer/nothing 404 no deployer route /v1/deployer/nothing",
    "GET /v1/events?kind=release.changed 200",
    "GET /v1/events?since=-1 400 invalid event cursor",
    "GET /v1/events?kind=unknown 400 unknown event kind",
    "DELETE /v1/events 405 DELETE is not allowed on /v1/events",
  ];
  const otherKey = [
    "GET /v1/health?past=admission 403 caller is not a tailnet node this control plane allows",
    "POST /v1/health 403 caller is not a tailnet node this control plane allows",
    "GET /v1/release 403 caller is not a tailnet node this control plane allows",
    "PUT /v1/release 403 caller is not a tailnet node this control plane allows",
    "PUT /v1/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/release 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/release 200",
    "POST /v1/deployer/release 405 POST is not allowed on /v1/deployer/release",
    "POST /v1/deployer/report 200",
    "POST /v1/deployer/report 403 only the control node reports control health",
    "POST /v1/deployer/report 400 ✖ Invalid option: expected one of \"pending\"|\"waiting-for-control\"|\"waiting-for-idle\"|\"installing\"|\"healthy\"|\"rolled-back\"|\"failed\"\n  → at state",
    "GET /v1/deployer/report 405 GET is not allowed on /v1/deployer/report",
    "POST /v1/deployer/drain 403 only the control node drains",
    "POST /v1/deployer/drain 403 only the control node drains",
    "GET /v1/deployer/drain 405 GET is not allowed on /v1/deployer/drain",
    "POST /v1/deployer/nothing 404 no deployer route /v1/deployer/nothing",
    "GET /v1/deployer/nothing 404 no deployer route /v1/deployer/nothing",
    "GET /v1/events?kind=release.changed 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?since=-1 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?kind=unknown 403 caller is not a tailnet node this control plane allows",
    "DELETE /v1/events 403 caller is not a tailnet node this control plane allows",
  ];
  const stranger = [
    "GET /v1/health?past=admission 403 caller is not a tailnet node this control plane allows",
    "POST /v1/health 403 caller is not a tailnet node this control plane allows",
    "GET /v1/release 403 caller is not a tailnet node this control plane allows",
    "PUT /v1/release 403 caller is not a tailnet node this control plane allows",
    "PUT /v1/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/release 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?kind=release.changed 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?since=-1 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?kind=unknown 403 caller is not a tailnet node this control plane allows",
    "DELETE /v1/events 403 caller is not a tailnet node this control plane allows",
  ];
  assert.deepEqual(answers, {
    "a deployer": deployer,
    "an allowed caller who is not a deployer": allowed,
    "an allowed caller while deploys are off": allowed,
    "the control node": allowed,
    "the control node with its deployer key": controlKey,
    "the control node with another key": allowed,
    "an allowed laptop with the control node's key": deployer,
    "another node with its deployer key": otherKey,
    "a stranger": stranger,
    "a stranger with the control node's key": stranger,
  });
});

test("only a person starts a thread, starts a queued one now or messages one, never the control node, an infrastructure node or a pylon", async (t) => {
  const s = await withQueue(t);
  const testbench = "nTESTBENCH" as TailnetNodeId;
  s.registry.upsertNode({ name: "infra-testbench" as NodeName, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: testbench });
  const queued = (await s.call("POST", "/v1/threads", { project: "acme", title: "Then", after: [s.first.id] })).body as QueuedThread;
  // A pylon's request leaves through its node, so whois names that node.
  const pylonNode = s.registry.nodes().find((n) => n.name === s.registry.pylon(s.first.pylonId)!.node)!.tailnetNodeId;
  const routes = [
    ["start a thread", "/v1/threads", { project: "acme", title: "Another" }, 201],
    ["start a queued thread", `/v1/threads/${queued.id}/start`, undefined, 201],
    ["message a thread", `/v1/threads/${s.first.id}/messages`, { text: "Go.", requestId: "msg:1" }, 202],
  ] as const;
  for (const [who, caller] of [["the control node", "nFIREBAT" as TailnetNodeId], ["an infrastructure node", testbench], ["a pylon", pylonNode]] as const) {
    s.callAs(caller);
    for (const [action, path, body] of routes) {
      const error = `caller may not ${action}: only a person may, never the control plane, infrastructure nodes or pylons`;
      assert.deepEqual(await s.call("POST", path, body), { status: 403, body: { error } }, `${who} may not ${action}`);
    }
  }
  assert.equal(s.calls.length, 1, "no refused request started or messaged a thread");
  assert.equal(s.registry.queuedThread(queued.id)?.status, "queued");

  s.callAs(phone);
  for (const [action, path, body, status] of routes) {
    const answer = await s.call("POST", path, body);
    assert.equal(answer.status, status, `a person who is not a deployer may ${action}: ${JSON.stringify(answer.body)}`);
  }
  assert.deepEqual(s.calls.map((c) => c[0]), ["start", "start", "start", "send"]);
});

test("only a person acts on a thread, its pylon or a project, never the control node, an infrastructure node or a pylon", async (t) => {
  const reviewed: unknown[][] = [];
  const reviews = {
    async start(...args: unknown[]) { reviewed.push(["start", ...args]); return { id: "rv-1" }; },
    cancel(...args: unknown[]) { reviewed.push(["cancel", ...args]); return { id: "rv-1" }; },
  } as never as ReviewLoop;
  const s = await withThread(t, { reviews });
  const testbench = "nTESTBENCH" as TailnetNodeId;
  s.registry.upsertNode({ name: "infra-testbench" as NodeName, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: testbench });
  const pylonNode = s.registry.nodes().find((n) => n.name === s.registry.pylon(s.thread.pylonId)!.node)!.tailnetNodeId;
  const id = s.thread.id;
  const routes = [
    ["abort a thread's turn", "POST", `/v1/threads/${id}/abort`, undefined, 204],
    ["retry a thread's turn", "POST", `/v1/threads/${id}/retry`, undefined, 204],
    ["retry a thread's pylon", "POST", `/v1/threads/${id}/pylon/retry`, undefined, 204],
    ["open a session in a thread's pylon", "POST", `/v1/threads/${id}/sessions`, { harness: "shell" }, 201],
    ["close a session in a thread's pylon", "DELETE", `/v1/threads/${id}/sessions/${encodeURIComponent("w1:p1")}`, {}, 204],
    ["focus a session in a thread's pylon", "POST", `/v1/threads/${id}/sessions/${encodeURIComponent("w1:p1")}/focus`, {}, 204],
    ["publish a preview", "POST", `/v1/threads/${id}/previews`, { port: 3000 }, 200],
    ["unpublish a preview", "DELETE", `/v1/threads/${id}/previews/3000`, {}, 204],
    ["start a review", "POST", `/v1/threads/${id}/review`, {}, 201],
    ["cancel a review", "POST", `/v1/threads/${id}/review/cancel`, undefined, 200],
    ["edit a project", "PATCH", "/v1/projects/acme", { defaultBranch: "trunk" }, 200],
    ["archive a thread", "POST", `/v1/threads/${id}/archive`, undefined, 200],
    ["unarchive a thread", "POST", `/v1/threads/${id}/unarchive`, undefined, 200],
    ["delete a thread", "DELETE", `/v1/threads/${id}`, {}, 200],
  ] as const;
  const harnessCalls = s.calls.length;
  for (const [who, caller] of [["the control node", "nFIREBAT" as TailnetNodeId], ["an infrastructure node", testbench], ["a pylon", pylonNode]] as const) {
    s.callAs(caller);
    for (const [action, method, path, body] of routes) {
      const error = `caller may not ${action}: only a person may, never the control plane, infrastructure nodes or pylons`;
      assert.deepEqual(await s.call(method, path, body), { status: 403, body: { error } }, `${who} may not ${action}`);
    }
    const attached = await attachTo(s.port, attachPathOf(id));
    assert.ok("status" in attached, `${who} is refused before the 101`);
    assert.deepEqual([attached.status, attached.body.error], [403, "caller may not attach to a thread's pylon: only a person may, never the control plane, infrastructure nodes or pylons"]);
  }
  assert.deepEqual([s.calls.length, s.commands, s.streams, reviewed], [harnessCalls, [], [], []], "no refused request reached the harness, the probe or the review loop");
  assert.equal(s.registry.thread(id)!.status, "active");
  assert.equal(s.registry.project("acme" as ProjectId)!.defaultBranch, project.defaultBranch);

  s.callAs(phone);
  s.registry.savePylon({ ...s.registry.pylon(s.thread.pylonId)!, failed: "last job failed with setup-failed" });
  for (const [action, method, path, body, status] of routes) {
    const answer = await s.call(method, path, body);
    assert.equal(answer.status, status, `a person who is not a deployer may ${action}: ${JSON.stringify(answer.body)}`);
  }
  assert.deepEqual(reviewed.map((r) => r[0]), ["start", "cancel"]);
});

test("the route table holds the routes it always has, and each path matches one route of its method, so their order is free except for /threads/new before the thread page", () => {
  const table = featureRoutes({} as ApiKit, {} as ApiOptions, async () => { throw new Error("unused"); });
  const described = table.map((entry) => {
    if (entry[0] === "GET") return `GET ${entry[1].source}`;
    const policy = entry[2];
    const declared = "person" in policy ? `person: ${policy.person}` : `open: ${policy.open}`;
    return `${entry[0]} ${entry[1].source} ${declared}${policy.startsTurn ? ", startsTurn" : ""}`;
  });
  assert.deepEqual(described.sort(), [
    "DELETE ^\\/v1\\/threads\\/([^/]+)$ person: delete a thread",
    "DELETE ^\\/v1\\/threads\\/([^/]+)\\/previews\\/([^/]+)$ person: unpublish a preview",
    "DELETE ^\\/v1\\/threads\\/([^/]+)\\/sessions\\/([^/]+)$ person: close a session in a thread's pylon",
    "DELETE ^\\/v1\\/usage\\/backfill$ open: deployers only, which steerUsageBackfill checks",
    "GET ^\\/$",
    "GET ^\\/assets\\/([\\w.-]+)$",
    "GET ^\\/nodes\\/([^/]+)$",
    "GET ^\\/pipeline$",
    "GET ^\\/projects\\/new$",
    "GET ^\\/threads\\/([^/]+)$",
    "GET ^\\/threads\\/([^/]+)\\/stream$",
    "GET ^\\/threads\\/new$",
    "GET ^\\/usage$",
    "GET ^\\/v1\\/deployer\\/release$",
    "GET ^\\/v1\\/doctor$",
    "GET ^\\/v1\\/events$",
    "GET ^\\/v1\\/images$",
    "GET ^\\/v1\\/images\\/current$",
    "GET ^\\/v1\\/items$",
    "GET ^\\/v1\\/items\\/([^/]+)$",
    "GET ^\\/v1\\/nodes$",
    "GET ^\\/v1\\/nodes\\/([^/]+)\\/health$",
    "GET ^\\/v1\\/projects$",
    "GET ^\\/v1\\/queued$",
    "GET ^\\/v1\\/queued\\/([^/]+)$",
    "GET ^\\/v1\\/release$",
    "GET ^\\/v1\\/reports$",
    "GET ^\\/v1\\/reports\\/([^/]+)$",
    "GET ^\\/v1\\/threads$",
    "GET ^\\/v1\\/threads\\/([^/]+)$",
    "GET ^\\/v1\\/threads\\/([^/]+)\\/changes$",
    "GET ^\\/v1\\/threads\\/([^/]+)\\/claude\\/events$",
    "GET ^\\/v1\\/threads\\/([^/]+)\\/conversation$",
    "GET ^\\/v1\\/threads\\/([^/]+)\\/diff$",
    "GET ^\\/v1\\/threads\\/([^/]+)\\/events$",
    "GET ^\\/v1\\/threads\\/([^/]+)\\/files$",
    "GET ^\\/v1\\/threads\\/([^/]+)\\/files\\/content$",
    "GET ^\\/v1\\/threads\\/([^/]+)\\/image$",
    "GET ^\\/v1\\/usage$",
    "GET ^\\/v1\\/usage\\/backfill$",
    "PATCH ^\\/v1\\/projects\\/([^/]+)$ person: edit a project",
    "POST ^\\/v1\\/deployer\\/drain$ open: admit lets only a reporter reach a deployer route, and the route only the control node",
    "POST ^\\/v1\\/deployer\\/report$ open: admit lets only a reporter reach a deployer route",
    "POST ^\\/v1\\/images$ open: recording an image boots nothing until a deployer rolls it out",
    "POST ^\\/v1\\/images\\/build$ open: deployers only, which imageRollout checks",
    "POST ^\\/v1\\/images\\/rollback$ open: deployers only, which imageRollout checks",
    "POST ^\\/v1\\/images\\/rollout$ open: deployers only, which imageRollout checks",
    "POST ^\\/v1\\/items$ person: add an item",
    "POST ^\\/v1\\/items\\/([^/]+)\\/approve$ person: approve an item",
    "POST ^\\/v1\\/items\\/([^/]+)\\/cancel$ person: cancel an item",
    "POST ^\\/v1\\/projects$ open: adding a project changes no thread, pylon or project there is",
    "POST ^\\/v1\\/questions\\/([^/]+)\\/answer$ open: each question says who may answer it, which refusalOf checks",
    "POST ^\\/v1\\/threads$ person: start a thread, startsTurn",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/(seen|unseen)$ open: what the person has read changes no thread or pylon",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/abort$ person: abort a thread's turn",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/activity$ open: a page open on the thread only keeps its pylon awake",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/archive$ person: archive a thread",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/land$ open: deployers only, which mayLand checks",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/messages$ person: message a thread, startsTurn",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/previews$ person: publish a preview",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/pylon\\/retry$ person: retry a thread's pylon",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/retry$ person: retry a thread's turn, startsTurn",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/review$ person: start a review",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/review\\/cancel$ person: cancel a review",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/sessions$ person: open a session in a thread's pylon",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/sessions\\/([^/]+)\\/focus$ person: focus a session in a thread's pylon",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/start$ person: start a queued thread, startsTurn",
    "POST ^\\/v1\\/threads\\/([^/]+)\\/unarchive$ person: unarchive a thread",
    "POST ^\\/v1\\/usage\\/backfill$ open: deployers only, which steerUsageBackfill checks",
    "PUT ^\\/v1\\/release$ open: deployers only, which the route checks with its own refusal",
  ]);
  const routes = [["GET", /^\/v1\/health$/] as const, ...table];
  for (const [method, regex] of routes) {
    const path = regex.source.slice(1, -1).replaceAll("\\/", "/").replaceAll("(seen|unseen)", "seen").replaceAll("([^/]+)", "x").replaceAll("([\\w.-]+)", "x");
    const matching = routes.filter((other) => other[0] === method && other[1].test(path));
    assert.equal(matching.length, path === "/threads/new" ? 2 : 1, `${method} ${path} matches ${matching.length} routes of its method`);
    assert.equal(matching[0]![1], regex);
  }
});
