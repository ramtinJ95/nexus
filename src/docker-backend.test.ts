import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerBackend } from "./docker-backend.ts";
import { dockerHostBridge } from "./docker-host-bridge.ts";
import { dockerServices } from "./docker-services.ts";
import type { PylonId } from "./protocol.ts";
import { checkoutDir } from "./sessions.ts";
import { freePort } from "./test-kit.ts";

type Reply = { stdout?: string; stderr?: string; code?: number };

/**
 * A `docker` first on PATH that logs each argv and answers from `replies`, keyed by the longest leading run of its
 * arguments joined by spaces. Its `exec` runs the command on this host instead, with the container's checkout and
 * services directory under `root`, so a container's files are the test's.
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
  const remap = (arg) => arg.replaceAll(${JSON.stringify(checkoutDir)}, ${JSON.stringify(join(root, "checkout"))}).replaceAll("/run/nexus-services", ${JSON.stringify(join(root, "run"))})
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

test("a container without a services file runs no services, and one with a file runs what it declares", async (t) => {
  const docker = await fakeDocker(t, { "port pylon-a": { stdout: "8000/tcp -> 127.0.0.1:49000\n" } });
  const services = dockerServices();
  await services.apply(pylon, {}, false);
  assert.deepEqual(await services.operate(pylon, "list"), []);

  await mkdir(join(docker.root, "checkout", ".nexus"), { recursive: true });
  await writeFile(join(docker.root, "checkout", ".nexus", "services.yaml"), "services:\n  web:\n    command: serve\n    port: 8000\n");
  // Stopped on purpose, so the apply starts nothing.
  await mkdir(join(docker.root, "run"));
  await writeFile(join(docker.root, "run", "web.stopped"), "");
  await services.apply(pylon, {}, false);
  assert.deepEqual(await services.operate(pylon, "list"), [{ name: "web", state: "stopped", port: 8000, declared: true, wantsPreview: false }]);
});

test("a services file the container cannot read, and a failed step in the container, fail with the exit code and the output", async (t) => {
  const docker = await fakeDocker(t, { "port pylon-a": { stdout: "8001/tcp -> 127.0.0.1:49001\n" } });
  await mkdir(join(docker.root, "checkout", ".nexus", "services.yaml"), { recursive: true });
  const services = dockerServices();
  await assert.rejects(services.apply(pylon, {}, false), { message: new RegExp(`^reading ${checkoutDir}/\\.nexus/services\\.yaml in pylon-a exited 1: cat: .*Is a directory`) });

  await rm(join(docker.root, "checkout"), { recursive: true });
  // A file where the services directory goes, so making it fails.
  await writeFile(join(docker.root, "run"), "");
  await services.apply(pylon, {}, false);
  await assert.rejects(services.link(pylon, 8001), { message: /^in pylon-a, mkdir -p \/run\/nexus-services .* exited 1: mkdir: .*File exists$/ });
});

test("a spawn for reading leaves a checkpoint's relaunch mark, and the pause after it keeps the sessions that checkpoint carried, recording none", async (t) => {
  const paused = Buffer.from(JSON.stringify([{ id: "w1:p1", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, title: "sh" }])).toString("base64url");
  const labels = { "nexus.pylon": pylon, "nexus.image": "img-test00000000", "nexus.booted-from": "ckpt-a-1", "nexus.checkpoint": "ckpt-a-1", "nexus.sessions": paused };
  const docker = await fakeDocker(t, { ps: { stdout: "c1\n" }, "container inspect c1": running("c1", labels), "port c1": { stdout: "" }, [`port ${pylon}`]: { stdout: "" } });
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
