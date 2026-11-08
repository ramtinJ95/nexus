import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { createDockerBackend } from "./docker-backend.ts";
import { dockerHostBridge } from "./docker-host-bridge.ts";
import { dockerServiceGuest } from "./docker-service-guest.ts";
import { GuestServices } from "../pylon-vm/services.ts";
import { checkedIn } from "../pylon-vm/guest.ts";
import type { PylonId } from "../ids.ts";
import { freePort } from "../test-support/kit.ts";
import { checkoutDir, servicesFile } from "../../images/pylon/nexus-contract.ts";

type Reply = { stdout?: string; stderr?: string; code?: number };

/**
 * A `docker` first on PATH that logs each argv and answers from `replies`, keyed by the longest leading run of its
 * arguments joined by spaces. Its `exec` runs the command on this host instead, with the container's checkout and
 * other directories under `root`, so a container's files are the test's.
 */
async function fakeDocker(t: TestContext, replies: Record<string, Reply> = {}) {
  const bin = await realpath(await mkdtemp(join(tmpdir(), "nexus-fake-docker-")));
  // A docker call can still be running when the call beside it fails the operation, and it writes here until it exits.
  t.after(() => rm(bin, { recursive: true, force: true, maxRetries: 10 }));
  const root = join(bin, "container");
  await mkdir(root);
  await writeFile(join(bin, "replies.json"), JSON.stringify(replies));
  await writeFile(join(bin, "docker"), `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(bin, "calls"))}, JSON.stringify(argv) + "\\n");
if (argv[0] === "exec") {
  let i = 1, cwd = ${JSON.stringify(bin)};
  for (; argv[i].startsWith("--"); i++) if (argv[i] === "--workdir") cwd = argv[++i]; else if (argv[i] === "--env") i++;
  const remap = (arg) => arg.replaceAll(${JSON.stringify(checkoutDir)}, ${JSON.stringify(join(root, "checkout"))}).replaceAll("/run/nexus-services", ${JSON.stringify(join(root, "run"))}).replaceAll("/var/lib/pi-sandbox", ${JSON.stringify(join(root, "pi-sandbox"))})
    .replaceAll("/var/lib/nexus", ${JSON.stringify(join(root, "var"))}).replaceAll("/home/user/.nexus", ${JSON.stringify(join(root, "nexus"))})
    .replaceAll("/proc/1/fd/1", ${JSON.stringify(join(root, "container.log"))});
  const [program, ...args] = argv.slice(i + 1).map(remap);
  const child = spawn(program, args, { cwd, stdio: "inherit" });
  process.on("SIGTERM", () => { child.kill("SIGKILL"); process.exit(143); });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const replies = JSON.parse(readFileSync(${JSON.stringify(join(bin, "replies.json"))}, "utf8"));
  let reply = {};
  for (let n = argv.length; n > 0; n--) if (replies[argv.slice(0, n).join(" ")]) { reply = replies[argv.slice(0, n).join(" ")]; break; }
  process.stdout.write(reply.stdout ?? "");
  process.stderr.write(reply.stderr ?? "");
  process.exitCode = reply.code ?? 0;
}
`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });
  return {
    root,
    answer: (next: Record<string, Reply>) => writeFile(join(bin, "replies.json"), JSON.stringify(next)),
    async calls(): Promise<string[][]> {
      return (await readFile(join(bin, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

const pylon = "pylon-a" as PylonId;
const images = { "img-test00000000": "nexus-test:latest" } as const;
const running = (id: string, labels: Record<string, string>) => ({
  stdout: JSON.stringify([{ Id: id, State: { Status: "running", StartedAt: "2026-10-27T00:00:00Z", ExitCode: 0 }, Config: { Labels: labels } }]),
});
const hasPair = (argv: readonly string[], a: string, b: string) => argv.some((arg, i) => arg === a && argv[i + 1] === b);

test("every container and checkpoint lookup is scoped by a --filter for each of the backend's labels", async (t) => {
  const docker = await fakeDocker(t);
  const backend = createDockerBackend({ images, labels: { "nexus.test": "pin", "nexus.run": "7" } });
  assert.deepEqual(await backend.list(), []);
  const lookups = (await docker.calls()).filter((argv) => argv[0] === "ps" || argv[0] === "images");
  assert.deepEqual(lookups.map((argv) => argv[0]).sort(), ["images", "ps"]);
  for (const argv of lookups) {
    assert.ok(hasPair(argv, "--filter", "label=nexus.test=pin") && hasPair(argv, "--filter", "label=nexus.run=7"), argv.join(" "));
  }
});

test("a docker failure names the command and Docker's trimmed stderr, or Node's reason when Docker said nothing", async (t) => {
  const command = "docker ps -a -q --no-trunc --filter label=nexus.pylon --filter label=nexus.test=pin";
  const docker = await fakeDocker(t, { ps: { stderr: "\n  Cannot connect to the Docker daemon  \n", code: 1 } });
  const backend = createDockerBackend({ images, labels: { "nexus.test": "pin" } });
  await assert.rejects(backend.list(), { message: `${command}: Cannot connect to the Docker daemon` });

  await docker.answer({ ps: { code: 1 } });
  await assert.rejects(backend.list(), (err: Error) => err.message.startsWith(`${command}: Command failed: ${command}`));
});

test("a container removed between its listing and its inspection is left out, and one still there is listed", async (t) => {
  await fakeDocker(t, {
    ps: { stdout: "gone\nkept\n" },
    "container inspect gone": { stderr: "Error response from daemon: No such container: gone\n", code: 1 },
    "container inspect kept": running("kept", { "nexus.pylon": pylon, "nexus.image": "img-test00000000", "nexus.booted-from": "" }),
  });
  const backend = createDockerBackend({ images });
  assert.deepEqual((await backend.list()).map((p) => [p.pylonId, p.vm]), [[pylon, "running"]]);
});

test("a pylon's state reads only its own container, or with none its checkpoints, so a paused pylon is stopped and one with neither absent", async (t) => {
  const docker = await fakeDocker(t, { ps: { stdout: "c1\n" }, "container inspect c1": running("c1", { "nexus.pylon": pylon, "nexus.image": "img-test00000000", "nexus.booted-from": "" }) });
  const backend = createDockerBackend({ images });
  assert.equal(await backend.state(pylon), "running");
  const checkpoint = { Id: "i1", Created: "2026-10-27T00:00:00Z", Config: { Labels: { "nexus.pylon": pylon, "nexus.image": "img-test00000000", "nexus.checkpoint": "ckpt-a-1" } } };
  await docker.answer({ images: { stdout: "i1\n" }, "image inspect i1": { stdout: JSON.stringify([checkpoint]) } });
  assert.equal(await backend.state(pylon), "stopped");
  await docker.answer({});
  assert.equal(await backend.state(pylon), "absent");
  for (const argv of (await docker.calls()).filter((argv) => argv[0] === "ps" || argv[0] === "images")) {
    assert.ok(hasPair(argv, "--filter", `label=nexus.pylon=${pylon}`), argv.join(" "));
  }
});

test("a guest exec answers its exit code with stdout then stderr, a nonzero exit as a result, and a timeout as a null exit code with the output so far", async (t) => {
  const docker = await fakeDocker(t, { ps: { stdout: "c1\n" }, "container inspect c1": running("c1", { "nexus.pylon": pylon }) });
  const guest = createDockerBackend({ images, labels: { "nexus.test": "pin" } }).guest(pylon);
  const cwd = docker.root;

  assert.deepEqual(await guest.exec(["sh", "-c", "printf err >&2; pwd"], { cwd, timeoutMs: 10_000 }), { exitCode: 0, output: `${cwd}\nerr`, truncated: false });
  assert.deepEqual(await guest.exec(["sh", "-c", "printf out; printf err >&2; exit 7"], { cwd, timeoutMs: 10_000 }), { exitCode: 7, output: "outerr", truncated: false });
  assert.deepEqual(await guest.exec(["sh", "-c", "printf partial; exec sleep 30"], { cwd, timeoutMs: 1500 }), { exitCode: null, output: "partial", truncated: false });
  const lookup = (await docker.calls()).find((argv) => argv[0] === "ps")!;
  assert.ok(hasPair(lookup, "--filter", `label=nexus.pylon=${pylon}`) && hasPair(lookup, "--filter", "label=nexus.test=pin"), lookup.join(" "));
});

test("before a spawn reaches a container, its services, links and preview origins are unavailable, naming why", async (t) => {
  await fakeDocker(t);
  const guest = createDockerBackend({ images }).guest(pylon);
  const why = "pylon-a is not running, or no spawn has reached it since the probe started";
  assert.deepEqual(guest.previewOrigin("web"), { unavailable: why });
  await assert.rejects(guest.services("list"), { message: why });
  await assert.rejects(guest.linkPort(8000), { message: why });
});

test("a container's services file is read by its stamp, a missing one declares no services, and one the container cannot read or a failed step fails with the exit code and the output", async (t) => {
  const docker = await fakeDocker(t);
  const dir = await mkdtemp(join(tmpdir(), "nexus-docker-services-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const guest = dockerServiceGuest(pylon);
  t.after(() => guest.close());
  const services = new GuestServices(guest, dir, servicesFile, checkoutDir, "user", {});
  assert.equal(await guest.stamp(servicesFile), null);
  assert.equal(await guest.readFile(servicesFile), null);
  assert.deepEqual(await services.operate("status"), []);
  await assert.rejects(services.attach(22), { message: "Port 22 is Nexus's own, so it cannot be previewed" });

  await mkdir(join(docker.root, "checkout", ".nexus", "services.yaml"), { recursive: true });
  await assert.rejects(guest.readFile(servicesFile), { message: new RegExp(`^reading ${checkoutDir}/\\.nexus/services\\.yaml in pylon-a exited 1: cat: .*Is a directory$`) });
  await writeFile(join(docker.root, "run"), "");
  await assert.rejects(checkedIn(guest, "mkdir -p /run/nexus-services/x"), { message: /^Guest command exited 1: mkdir: .*/ });
  assert.deepEqual(await guest.execute("echo out; echo err >&2; exit 3", 10_000), { exitCode: 3, output: "out\nerr\n" });
  await guest.writeFile(`${checkoutDir}/written`, "content");
  assert.equal((await guest.readFile(`${checkoutDir}/written`))?.toString(), "content");
});

test("the ingress sends each request to its longest matching route's port, without the prefix and with Gondolin's forwarded headers, and answers 404 without a route and 502 without a listener", async (t) => {
  await fakeDocker(t);
  const app = createServer((req, res) => res.end(JSON.stringify({ url: req.url, host: req.headers.host, forwarded: [req.headers["x-forwarded-host"], req.headers["x-forwarded-proto"], req.headers["x-forwarded-prefix"]] })));
  await new Promise<void>((accept) => app.listen(0, "127.0.0.1", accept));
  t.after(() => app.close());
  const port = (app.address() as { port: number }).port;
  const guest = dockerServiceGuest(pylon);
  t.after(() => guest.close());
  const base = await guest.ingress();
  guest.setIngressRoutes([{ prefix: "/web/", port: 1, stripPrefix: true }, { prefix: "/web/api/", port, stripPrefix: true }, { prefix: "/down/", port: await freePort(), stripPrefix: true }]);
  const body = await new Promise<string>((accept, reject) => {
    request(new URL("/web/api/x?y=1", base), { headers: { host: "pylon.example:8443" } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; }).on("end", () => accept(text));
    }).on("error", reject).end();
  });
  assert.deepEqual(JSON.parse(body), { url: "/x?y=1", host: "pylon.example:8443", forwarded: ["pylon.example:8443", "http", "/web/api"] });
  assert.equal((await fetch(new URL("/web/api", base))).status, 200, "the prefix alone is routed, as /");
  assert.equal((await fetch(new URL("/elsewhere/", base))).status, 404);
  assert.equal((await fetch(new URL("/down/", base))).status, 502);
});

test("a spawn for reading leaves a checkpoint's relaunch mark, and the pause after it keeps the sessions that checkpoint carried, recording none", async (t) => {
  const paused = Buffer.from(JSON.stringify([{ id: "w1:p1", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, title: "sh" }])).toString("base64url");
  const labels = { "nexus.pylon": pylon, "nexus.image": "img-test00000000", "nexus.booted-from": "ckpt-a-1", "nexus.checkpoint": "ckpt-a-1", "nexus.sessions": paused };
  const docker = await fakeDocker(t, { ps: { stdout: "c1\n" }, "container inspect c1": running("c1", labels) });
  const mark = join(docker.root, "var", "relaunch");
  await mkdir(join(mark, ".."), { recursive: true });
  await writeFile(mark, "");
  const backend = createDockerBackend({ images });
  const boot = {
    pylonId: pylon, image: "img-test00000000" as const, source: { kind: "resume" as const, checkpoint: "ckpt-a-1" as const }, resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 },
    network: { allowedHosts: [], secrets: [] }, repo: { kind: "empty" as const, branch: "main" }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  };
  await backend.ensureRunning(boot, { previews: [], overlay: [] }, AbortSignal.timeout(10_000), false);
  assert.equal(await readFile(mark, "utf8"), "", "the mark stays for the spawn that brings the sessions back");

  await backend.ensurePaused(pylon, "ckpt-a-2", AbortSignal.timeout(10_000));
  const calls = await docker.calls();
  assert.ok(!calls.some((argv) => argv.includes("herdr") || argv.some((arg) => arg.includes("sessions.json"))), "nothing read or recorded the sessions");
  const commit = calls.find((argv) => argv[0] === "commit")!;
  assert.ok(hasPair(commit, "--change", `LABEL nexus.sessions="${paused}"`) && hasPair(commit, "--change", 'LABEL nexus.checkpoint="ckpt-a-2"'), commit.join(" "));
});

test("a pause whose session record fails keeps the sessions its checkpoint's pause recorded", async (t) => {
  const paused = Buffer.from(JSON.stringify([{ id: "w1:p1", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, title: "sh" }])).toString("base64url");
  const labels = { "nexus.pylon": pylon, "nexus.image": "img-test00000000", "nexus.booted-from": "ckpt-a-1", "nexus.checkpoint": "ckpt-a-1", "nexus.sessions": paused };
  const docker = await fakeDocker(t, { ps: { stdout: "c1\n" }, "container inspect c1": running("c1", labels) });
  // First on the PATH the container's commands run with, so the record fails as a guest without Herdr's server would.
  await writeFile(join(docker.root, "..", "herdr"), "#!/bin/sh\necho 'herdr: broken on purpose' >&2\nexit 1\n", { mode: 0o755 });
  await createDockerBackend({ images }).ensurePaused(pylon, "ckpt-a-2", AbortSignal.timeout(10_000));
  const calls = await docker.calls();
  assert.match(await readFile(join(docker.root, "container.log"), "utf8"), /^sessions: recording failed, so the wake relaunches what the last record holds: .*herdr: broken on purpose/);
  const commit = calls.find((argv) => argv[0] === "commit")!;
  assert.ok(hasPair(commit, "--change", `LABEL nexus.sessions="${paused}"`) && hasPair(commit, "--change", 'LABEL nexus.checkpoint="ckpt-a-2"'), commit.join(" "));
});

test("the host bridge names the pylon from the one running container carrying the token, scoped by a --filter for each label", async (t) => {
  const token = "0123456789abcdef0123456789abcdef";
  const docker = await fakeDocker(t, { ps: { stdout: `${pylon}\n` } });
  const port = await freePort();
  const bridge = await dockerHostBridge(port, { "nexus.test": "pin", "nexus.run": "7" })(async (pylonId, body) => ({ status: 200, body: JSON.stringify({ pylonId, body }) }));
  t.after(() => bridge.close());

  const res = await fetch(`http://127.0.0.1:${port}/${token}/v1/request`, { method: "POST", body: "hi" });
  assert.deepEqual(await res.json(), { pylonId: pylon, body: "hi" });
  const [ps] = await docker.calls();
  assert.equal(ps![0], "ps");
  for (const filter of [`label=nexus.bridge-token=${token}`, "label=nexus.test=pin", "label=nexus.run=7"]) assert.ok(hasPair(ps!, "--filter", filter), ps!.join(" "));
  assert.equal((await fetch(`http://127.0.0.1:${port}/not-a-token/v1/request`, { method: "POST" })).status, 404);
  assert.equal((await docker.calls()).length, 1, "a path without a token asks Docker nothing");
});

test("a checkpoint's sessions label is parsed, and one that does not parse is refused", async (t) => {
  const label = (sessions: unknown) => Buffer.from(JSON.stringify(sessions)).toString("base64url");
  const checkpoint = (sessions: string) => ({
    stdout: JSON.stringify([{ Id: "i1", Created: "2026-10-27T00:00:00Z", Config: { Labels: { "nexus.pylon": pylon, "nexus.image": "img-test00000000", "nexus.checkpoint": "ckpt-a-1", "nexus.sessions": sessions } } }]),
  });
  const session = { id: "w1:p1", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, title: "sh" };
  const docker = await fakeDocker(t, { images: { stdout: "i1\n" }, "image inspect i1": checkpoint(label([session])) });
  const backend = createDockerBackend({ images });
  assert.deepEqual(await backend.list(), [{ pylonId: pylon, vm: "stopped", checkpoint: "ckpt-a-1", image: "img-test00000000", sessions: [session] }]);

  await docker.answer({ images: { stdout: "i1\n" }, "image inspect i1": checkpoint(label([{ ...session, harness: "nobody" }])) });
  await assert.rejects(backend.list(), { message: /^label nexus\.sessions\[0\]\.harness: / });
});
