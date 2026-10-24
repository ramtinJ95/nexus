/**
 * What the pylon VM backend decides before it boots anything, and how it pauses an instance whose controller
 * died. No VM runs here: a boot that reached Gondolin would fail, so every test stops short of one. The real
 * boot path is checked by the slice test on a node (NEXUS_SLICE_BACKEND=pylon-vm).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createPylonVmBackend, type PylonVmBackendOptions } from "./pylon-vm-backend.ts";
import { identityOf } from "./pylon-vm/identity.ts";
import { pylonGuest } from "./pylon-vm/pylon-guest.ts";
import type { BootInputs } from "./project.ts";
import type { BrokenCause, PylonId } from "./protocol.ts";
import type { ImageId, TemplateBuildInputs, TemplateId, TemplateManifest } from "./images.ts";
import type { ProjectId } from "./project.ts";

// Under /tmp, not os.tmpdir(): macOS's per-user temp dir is too long for the controllers' Unix sockets.
const scratch = await mkdtemp("/tmp/nexus-pvb-");
after(() => rm(scratch, { recursive: true, force: true }));

const image: ImageId = "img-test00000000";
const artifacts = join(scratch, "artifacts");
const assets = join(artifacts, image);
await mkdir(assets, { recursive: true });
await writeFile(join(assets, "manifest.json"), "{}");
await writeFile(join(assets, "image.json"), "{}");
const live = { previews: [], overlay: [] };

let roots = 0;
async function backendWith(extra: Partial<PylonVmBackendOptions> = {}) {
  const stateRoot = join(scratch, `state-${roots++}`);
  await mkdir(join(stateRoot, "instances"), { recursive: true, mode: 0o700 });
  const backend = createPylonVmBackend({ stateRoot, artifacts, secrets: { value: () => undefined }, ...extra });
  return { backend, stateRoot, instances: join(stateRoot, "instances") };
}

const gnuTar = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU tar") === true;
const key = { project: "proj" as ProjectId, image, setupHash: "h".repeat(64) };
const buildInputs: TemplateBuildInputs = {
  key,
  repo: { url: "https://github.com/octocat/Hello-World.git", branch: "master", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" },
  preSetup: null,
  allowedHosts: ["github.com"],
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 8 },
};

/** A template in the artifact store, as a published build leaves it. */
async function publishedTemplate(id: TemplateId, over: ImageId) {
  const dir = join(artifacts, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "disk.qcow2"), "template disk");
  const manifest: TemplateManifest = { id, key: { ...key, image: over }, commit: "c0ffee", builtAt: "2027-01-01T00:00:00.000Z", sha256: "0".repeat(64) };
  await writeFile(join(dir, "template.json"), JSON.stringify(manifest));
}

/** What the fork's prepare leaves in <stateRoot>/templates once its controller has exited. */
async function leftBuild(stateRoot: string, id: TemplateId, status: Record<string, unknown>, log: string) {
  const dir = join(stateRoot, "templates", id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const config = { version: 1, diskGiB: 8, image: assets, workspace: "/home/user/workspace", setup: [], resume: [], services: {} };
  await writeFile(join(dir, "record.json"), JSON.stringify({ version: 1, name: id, config, createdAt: "2026-10-22T00:00:00Z", labels: { "nexus.image": image } }));
  await writeFile(join(dir, "status.json"), JSON.stringify({ name: id, ...status }));
  await writeFile(join(dir, "controller.log"), log);
  return dir;
}

function bootOf(pylonId: string, changes: Partial<BootInputs> = {}): BootInputs {
  return {
    pylonId: pylonId as PylonId,
    image,
    source: { kind: "fresh", preSetup: null },
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 8 },
    network: { allowedHosts: ["github.com"], secrets: [] },
    repo: { kind: "clone", url: "https://github.com/octocat/Hello-World.git", checkout: { branch: "master", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" } },
    dotfiles: { repo: "https://github.com/octocat/Spoon-Knife.git", ref: "main" },
    ...changes,
  };
}

/** What a pi-sandbox-format instance looks like on disk after its controller died or stopped. */
async function leftInstance(instances: string, pylonId: string, state: "stopped" | "running" | "starting", diskGiB = 8, retrySetup = false) {
  const dir = join(instances, pylonId);
  await mkdir(dir, { mode: 0o700 });
  const config = { version: 1, diskGiB, image: assets, workspace: "/home/user/workspace", setup: [], retrySetup, resume: [], services: {} };
  await writeFile(join(dir, "record.json"), JSON.stringify({ version: 1, name: pylonId, config, createdAt: "2026-10-22T00:00:00Z", labels: { "nexus.image": image } }));
  await writeFile(join(dir, "status.json"), JSON.stringify({ name: pylonId, state }));
  return dir;
}

const signal = () => AbortSignal.timeout(10_000);

/**
 * A controller on the instance's control socket, as daemon.ts listens, answering each action from `answer`.
 * It always answers inspect with the instance in `state.current`.
 */
async function fakeController(dir: string, pylonId: string, answer: (action: Record<string, unknown>) => unknown = () => assert.fail("unexpected action")) {
  const state = { current: "running" };
  const actions: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const action = JSON.parse(body) as Record<string, unknown>;
    try {
      const result = action.action === "inspect"
        ? { name: pylonId, labels: { "nexus.image": image }, status: { name: pylonId, state: state.current } }
        : (actions.push(action), await answer(action));
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(join(dir, "control.sock"), resolve));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { state, actions };
}

/** The reply to an exec that finished, as the fork's process supervisor gives it. */
const finished = (exitCode: number, output = "") => ({ pid: "00000000-0000-4000-8000-000000000000", running: false, output, exitCode, truncated: false });
const herdrNoServer = JSON.stringify({ id: "cli:x", error: { code: "server_not_running", message: "no server" } }) + "\n";

test("a state root too long for a pylon's control socket is refused when the backend is created", () => {
  const stateRoot = `/var/lib/${"n".repeat(40)}`;
  assert.throws(() => createPylonVmBackend({ stateRoot, artifacts, secrets: { value: () => undefined } }), /a pylon's control socket would be 113 bytes, and a Unix socket path must stay under 104/);
  createPylonVmBackend({ stateRoot: "/var/lib/nexus/pylons", artifacts, secrets: { value: () => undefined } });
});

test("an SSH repo on a node without a git SSH key fails as secret-missing and creates nothing", async () => {
  const { backend, instances } = await backendWith();
  const boot = bootOf("pylon-ssh", { repo: { kind: "clone", url: "git@github.com:acme/web.git", checkout: { branch: "main", commit: "c0ffee" } } });
  await assert.rejects(backend.ensureRunning(boot, live, signal()), { code: "secret-missing", message: /github\.com:acme\/web\.git over SSH, and this node has no git SSH key/ });
  assert.equal(existsSync(join(instances, "pylon-ssh")), false);
});

test("an SSH dotfiles repo needs the key too, and a missing known_hosts file is named", async () => {
  const keyFile = join(scratch, "id_ed25519");
  await writeFile(keyFile, "not a real key\n");
  const { backend } = await backendWith({ gitSsh: { privateKeyFile: keyFile, knownHostsFile: join(scratch, "absent_known_hosts") } });
  const boot = bootOf("pylon-dots", { dotfiles: { repo: "ssh://git@git.example.com:2222/me/dotfiles.git", ref: "main" } });
  await assert.rejects(backend.ensureRunning(boot, live, signal()), { code: "secret-missing", message: /git\.example\.com:\/me\/dotfiles\.git over SSH, and this node's known_hosts file .*absent_known_hosts is missing/ });
});

test("SSH remotes Gondolin cannot serve are refused before any boot", async () => {
  const keyFile = join(scratch, "id_ed25519");
  await writeFile(keyFile, "not a real key\n");
  const { backend } = await backendWith({ gitSsh: { privateKeyFile: keyFile, knownHostsFile: keyFile } });
  const checkout = { branch: "main", commit: "c0ffee" };
  await assert.rejects(backend.ensureRunning(bootOf("pylon-flat", { repo: { kind: "clone", url: "git@git.example.com:web.git", checkout } }), live, signal()), { code: "invalid", message: /has no owner in its path/ });
  const twoUsers = bootOf("pylon-users", { repo: { kind: "clone", url: "alice@git.example.com:acme/web.git", checkout }, dotfiles: { repo: "bob@git.example.com:bob/dotfiles.git", ref: "main" } });
  await assert.rejects(backend.ensureRunning(twoUsers, live, signal()), { code: "invalid", message: /used as alice and as bob/ });
});

test("the git SSH key and secret values reach the controller but never the instance directory", async () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nnexus-test-key-body-0123456789\n-----END OPENSSH PRIVATE KEY-----\n";
  const keyFile = join(scratch, "id_test");
  await writeFile(keyFile, key);
  const { backend, instances } = await backendWith({
    gitSsh: { privateKeyFile: keyFile, knownHostsFile: keyFile },
    secrets: { value: () => "nexus-test-secret-value" },
  });
  const boot = bootOf("pylon-key", {
    resources: { cpus: 3, memoryGiB: 5, diskGiB: 8 },
    network: { allowedHosts: ["api.stripe.com"], secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }] },
    repo: { kind: "clone", url: "git@github.com:acme/web.git", checkout: { branch: "main", commit: "c0ffee" } },
  });
  // The assets are a bare manifest, so the controller fails once it reaches Gondolin.
  await assert.rejects(backend.ensureRunning(boot, live, AbortSignal.timeout(60_000)));
  const dir = join(instances, "pylon-key");
  const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert.deepEqual([status.state, status.resources], ["failed", { cpus: 3, memoryGiB: 5 }], "the controller booted with the spec from its stdin");
  for (const name of await readdir(dir)) {
    const text = await readFile(join(dir, name), "utf8").catch(() => "");
    assert.ok(!text.includes("nexus-test-key-body") && !text.includes("nexus-test-secret-value"), `${name} holds a secret`);
  }
});

test("a secret grant whose value this node lacks fails as secret-missing", async () => {
  const { backend, instances } = await backendWith({ secrets: { value: (name) => name === "PRESENT" ? "v" : undefined } });
  const boot = bootOf("pylon-sec", { network: { allowedHosts: ["api.stripe.com"], secrets: [{ name: "PRESENT", hosts: ["api.stripe.com"] }, { name: "STRIPE_KEY", hosts: ["api.stripe.com"] }] } });
  await assert.rejects(backend.ensureRunning(boot, live, signal()), { code: "secret-missing", message: /STRIPE_KEY/ });
  assert.equal(existsSync(join(instances, "pylon-sec")), false);
});

test("a repo URL that is neither SSH nor HTTPS is invalid", async () => {
  const { backend } = await backendWith();
  const boot = bootOf("pylon-url", { repo: { kind: "clone", url: "file:///srv/repo.git", checkout: { branch: "main", commit: "c0ffee" } } });
  await assert.rejects(backend.ensureRunning(boot, live, signal()), { code: "invalid", message: /neither an SSH nor an HTTPS git URL/ });
});

test("a boot under 3 GiB is refused, on a wake as on a create", async () => {
  const { backend, instances } = await backendWith();
  await assert.rejects(backend.ensureRunning(bootOf("pylon-small", { resources: { cpus: 2, memoryGiB: 2, diskGiB: 8 } }), live, signal()), { code: "invalid", message: /at least 3 GiB/ });
  await leftInstance(instances, "pylon-small2", "stopped");
  await assert.rejects(backend.ensureRunning(bootOf("pylon-small2", { resources: { cpus: 2, memoryGiB: 2, diskGiB: 8 } }), live, signal()), { code: "invalid", message: /at least 3 GiB/ });
});

test("a stopped pylon keeps its disk size and its image", async () => {
  const { backend, instances } = await backendWith();
  const dir = await leftInstance(instances, "pylon-fixed", "stopped", 8);
  await assert.rejects(backend.ensureRunning(bootOf("pylon-fixed", { resources: { cpus: 2, memoryGiB: 4, diskGiB: 16 } }), live, signal()), { code: "invalid", message: /has a 8 GiB disk and cannot boot with 16 GiB/ });
  await assert.rejects(backend.ensureRunning(bootOf("pylon-fixed", { image: "img-other0000000" }), live, signal()), { code: "invalid", message: /was created from img-test00000000 and cannot boot img-other0000000/ });
  assert.equal(JSON.parse(await readFile(join(dir, "status.json"), "utf8")).state, "stopped", "neither refusal started the instance");
});

test("pausing a pylon whose controller died settles it on its last disk without booting it", async () => {
  const { backend, instances } = await backendWith();
  await leftInstance(instances, "pylon-dead", "running");
  assert.deepEqual((await backend.list()).map((p) => [p.pylonId, p.vm, p.cause]), [["pylon-dead", "broken", "controller"]]);
  await backend.ensurePaused("pylon-dead" as PylonId, "ckpt-dead-1", signal());
  const [pylon] = await backend.list();
  assert.equal(pylon?.vm, "stopped");
  assert.equal(pylon.checkpoint, "ckpt-dead-1");
  assert.equal(existsSync(join(instances, "pylon-dead", "controller.pid")), false, "no controller was launched");
});

test("a pylon whose controller has yet to publish its PID is booting while its launcher lives, and broken after", async () => {
  const { backend, instances } = await backendWith();
  const dir = await leftInstance(instances, "pylon-launching", "starting");
  await mkdir(join(dir, "launch.lock"));
  await writeFile(join(dir, "launch.lock", "owner"), JSON.stringify(await identityOf(process.pid)));
  assert.deepEqual((await backend.list()).map((p) => p.vm), ["booting"]);
  await rm(join(dir, "launch.lock"), { recursive: true });
  assert.deepEqual((await backend.list()).map((p) => p.vm), ["broken"]);
});

test("a PID handed out again, or one from an earlier boot of the host, is a dead controller and a dead launcher", async () => {
  const { backend, instances } = await backendWith();
  const live = (await identityOf(process.pid))!;
  const reused = [{ ...live, start: "an earlier process" }, { ...live, boot: "an earlier host boot" }];
  const running = await leftInstance(instances, "pylon-reused", "running");
  await writeFile(join(running, "controller.pid"), JSON.stringify(live));
  assert.deepEqual((await backend.list()).map((p) => p.vm), ["booting"], "the live identity is a controller still coming up");
  for (const identity of reused) {
    await writeFile(join(running, "controller.pid"), JSON.stringify(identity));
    assert.deepEqual((await backend.list()).map((p) => p.vm), ["broken"]);
  }
  await rm(running, { recursive: true });
  const starting = await leftInstance(instances, "pylon-relaunched", "starting");
  await mkdir(join(starting, "launch.lock"));
  for (const identity of reused) {
    await writeFile(join(starting, "launch.lock", "owner"), JSON.stringify(identity));
    assert.deepEqual((await backend.list()).map((p) => p.vm), ["broken"]);
  }
});

test("a spawn with previews on a node without a preview host fails as invalid and creates nothing", async () => {
  const { backend, instances } = await backendWith();
  await assert.rejects(backend.ensureRunning(bootOf("pylon-nohost"), { previews: [{ service: "web", httpsPort: 10100 }], overlay: [] }, signal()), { code: "invalid", message: /no previewHost/ });
  assert.equal(existsSync(join(instances, "pylon-nohost")), false);
});

test("a preview origin is the loopback portal the controller reports, and a paused or absent pylon has none", async () => {
  const { backend, instances } = await backendWith();
  const dir = await leftInstance(instances, "pylon-origin", "running");
  const status = (state: string) => writeFile(join(dir, "status.json"), JSON.stringify({ name: "pylon-origin", state, previews: { web: "http://127.0.0.1:40001", "port-6006": "http://127.0.0.1:40002" } }));
  await status("running");
  const guest = backend.guest("pylon-origin" as PylonId);
  assert.equal(guest.previewOrigin("web"), "http://127.0.0.1:40001");
  assert.equal(guest.previewOrigin("port-6006"), "http://127.0.0.1:40002");
  assert.throws(() => guest.previewOrigin("api"), /pylon-origin has no preview of api/);
  await status("stopped");
  assert.throws(() => guest.previewOrigin("web"), /pylon-origin is stopped/);
  assert.throws(() => backend.guest("pylon-absent" as PylonId).previewOrigin("web"), /pylon-absent is not on this node/);
});

test("a raw stream runs its argv unchanged over SSH to the forwarder the controller hands out, stdout only", async (t) => {
  const { backend, instances } = await backendWith();
  const dir = await leftInstance(instances, "pylon-ssh-stream", "running");
  const { actions } = await fakeController(dir, "pylon-ssh-stream", (action) => {
    assert.equal(action.action, "shell");
    return { name: "pylon-ssh-stream", access: { user: "user", port: 40022, identityFile: "/run/keys/id" }, command: "ssh ...", handoff: "" };
  });
  // Stands in for OpenSSH: records its arguments, then runs the remote command through a shell, as sshd does.
  const bin = join(scratch, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${join(scratch, "ssh-args")}\nwhile [ "$1" != -- ]; do shift; done\nexec sh -c "$2"\n`);
  await chmod(join(bin, "ssh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });

  const logs: string[] = [];
  const guest = backend.guest("pylon-ssh-stream" as PylonId);
  const stream = await guest.stream({ pty: null, argv: ["sh", "-c", 'printf "%s|" "$@"; printf err >&2; exit 3', "sh", "a b", "it's", "$HOME", "*"] }, (text) => logs.push(text));
  await stream.close();
  let out = "";
  for await (const chunk of stream) out += Buffer.from(chunk).toString();
  assert.equal(out, "a b|it's|$HOME|*|");
  assert.deepEqual(await stream.done, { kind: "exited", code: 3 });
  assert.equal(logs.join(""), "err");
  const args = (await readFile(join(scratch, "ssh-args"), "utf8")).split("\n");
  assert.deepEqual([args[args.indexOf("-p") + 1], args[args.indexOf("-i") + 1], args[args.indexOf("--") - 1]], ["40022", "/run/keys/id", "user@127.0.0.1"]);
  assert.deepEqual(actions.map((a) => [a.action, a.user]), [["shell", "user"]]);
  await assert.rejects(guest.stream({ pty: { cols: 80, rows: 24 }, argv: ["bash"] }, () => {}), /raw pipes only/);
});

test("service facts come from the controller's supervisor, a list starts nothing, and logs name one service", async () => {
  const { backend, instances } = await backendWith();
  const dir = await leftInstance(instances, "pylon-svc", "running");
  const web = { name: "web", state: "ready", port: 8000, declared: true, wantsPreview: true };
  const { actions } = await fakeController(dir, "pylon-svc", (action) => {
    if (action.action === "services" || action.action === "service-start") return [web];
    if (action.action === "logs") return { exitCode: 0, output: "listening on 8000\n", truncated: false };
    if (action.action === "preview") return { service: "port-6006" };
    return assert.fail(`unexpected ${action.action}`);
  });
  const guest = backend.guest("pylon-svc" as PylonId);
  assert.deepEqual(await guest.services("ensure"), { services: [web] });
  assert.deepEqual(await guest.services("list"), { services: [web] });
  assert.deepEqual(await guest.services("logs", "web", 50), { services: [web], logs: "listening on 8000\n" });
  assert.equal(await guest.linkPort(6006, "Storybook"), "port-6006");
  assert.deepEqual(await guest.startService("web", { command: "npm run dev", port: 8000, preview: true }), [web]);
  assert.deepEqual(actions.map(({ name: _, ...a }) => a), [
    { action: "services", op: "ensure" },
    { action: "services", op: "status" },
    { action: "logs", service: "web", lines: 50 },
    { action: "services", op: "status", service: "web" },
    { action: "preview", port: 6006, title: "Storybook" },
    { action: "service-start", service: "web", command: "npm run dev", cwd: ".", port: 8000, env: {}, preview: true, previews: [], timeoutMs: 30000 },
  ]);
});

test("ensure, restart and service-start answer once each service they started is ready or failed, reading status between other actions, and a list does not wait", async () => {
  const fact = (state: string) => ({ name: "web", state, port: 8000, declared: true, wantsPreview: true });
  const actions: Record<string, unknown>[] = [];
  let reads: string[] = [];
  const guest = pylonGuest("pylon-wait" as PylonId, scratch, async ({ name: _, ...action }) => {
    actions.push(action);
    if (action.op === "status") return [fact(reads.shift()!)];
    return [fact("starting")];
  });
  reads = ["starting", "failed"];
  assert.deepEqual(await guest.services("ensure"), { services: [fact("failed")] });
  reads = ["ready"];
  assert.deepEqual(await guest.services("restart", "web"), { services: [fact("ready")] });
  reads = ["failed"];
  assert.deepEqual(await guest.startService("web", { command: "serve", port: 8000, preview: true }), [fact("failed")]);
  reads = ["starting"];
  assert.deepEqual(await guest.services("list"), { services: [fact("starting")] });
  assert.deepEqual(actions.map((a) => [a.action, a.op ?? null, a.service ?? null]), [
    ["services", "ensure", null], ["services", "status", null], ["services", "status", null],
    ["services", "restart", "web"], ["services", "status", "web"],
    ["service-start", null, "web"], ["services", "status", "web"],
    ["services", "status", null],
  ]);
});

test("a pause records the sessions while the guest runs, before it stops the VM, and logs the outcome", async () => {
  const { backend, instances } = await backendWith();
  const dir = await leftInstance(instances, "pylon-rec", "running");
  await writeFile(join(dir, "controller.log"), "");
  const controller = await fakeController(dir, "pylon-rec", (action) => {
    if (action.action === "exec") return finished(1, herdrNoServer);
    if (action.action === "stop") {
      controller.state.current = "stopped";
      return { name: "pylon-rec", state: "stopped" };
    }
    return assert.fail(`unexpected ${action.action}`);
  });
  await backend.ensurePaused("pylon-rec" as PylonId, "ckpt-rec-1", signal());
  assert.deepEqual(controller.actions.map((a) => a.action), ["exec", "stop"]);
  assert.match(String(controller.actions[0]!.cmd).replace(/['\\]/g, ""), /^runuser -l user -c cd \/home\/user && herdr --session nexus api snapshot$/);
  assert.equal(await readFile(join(dir, "controller.log"), "utf8"), "sessions: no Herdr server runs, so the last record stands\n");
  assert.deepEqual((await backend.list()).map((p) => [p.vm, p.checkpoint]), [["stopped", "ckpt-rec-1"]]);
});

test("a spawn of a running pylon applies the preview URLs, and finishes a relaunch a wake left pending, once", async () => {
  const { backend, instances } = await backendWith({ previewHost: "node.example.ts.net" });
  const dir = await leftInstance(instances, "pylon-wake", "running");
  await writeFile(join(dir, "nexus-checkpoint.json"), JSON.stringify({ checkpoint: "ckpt-wake-1", relaunch: true }));
  const { actions } = await fakeController(dir, "pylon-wake", (action) => {
    if (action.action === "write-files" || action.action === "public-urls") return {};
    // The sessions file is missing: this pylon was paused with nothing open.
    if (action.action === "exec") return finished(3);
    return assert.fail(`unexpected ${action.action}`);
  });
  const previews = { previews: [{ service: "web", httpsPort: 10100 }], overlay: [] };
  await backend.ensureRunning(bootOf("pylon-wake"), previews, signal());
  assert.deepEqual(actions.map((a) => a.action), ["write-files", "public-urls", "exec"]);
  assert.deepEqual(actions[1]!.urls, { web: "https://node.example.ts.net:10100" });
  assert.match(String(actions[2]!.cmd), /\.nexus\/sessions\.json/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "nexus-checkpoint.json"), "utf8")), { checkpoint: "ckpt-wake-1" });

  await backend.ensureRunning(bootOf("pylon-wake"), previews, signal());
  assert.deepEqual(actions.map((a) => a.action), ["write-files", "public-urls", "exec", "write-files", "public-urls"], "the relaunch ran once");
});

test("a pylon boots only from a template on this node that is a disk over its own image", async () => {
  const { backend, instances } = await backendWith();
  const missing = bootOf("pylon-tpl", { source: { kind: "template", template: "tpl-absent000000" } });
  await assert.rejects(backend.ensureRunning(missing, live, signal()), { code: "artifact-missing", message: /template tpl-absent000000 is not on this node/ });
  await publishedTemplate("tpl-otherimage00", "img-other0000000");
  const other = bootOf("pylon-tpl", { source: { kind: "template", template: "tpl-otherimage00" } });
  await assert.rejects(backend.ensureRunning(other, live, signal()), { code: "invalid", message: /is a disk over img-other0000000, and the pylon boots img-test00000000/ });
  assert.equal(existsSync(join(instances, "pylon-tpl")), false);
});

test("a template boot copies the template's disk in and sets up only the pylon's own checkout", async () => {
  const { backend, instances } = await backendWith();
  await publishedTemplate("tpl-bootable0000", image);
  const boot = bootOf("pylon-from-tpl", { source: { kind: "template", template: "tpl-bootable0000" } });
  // The assets are a bare manifest, so the controller fails once it reaches Gondolin.
  await assert.rejects(backend.ensureRunning(boot, live, AbortSignal.timeout(60_000)));
  const dir = join(instances, "pylon-from-tpl");
  assert.equal(await readFile(join(dir, "disk.qcow2"), "utf8"), "template disk");
  assert.equal(await readFile(join(artifacts, "tpl-bootable0000", "disk.qcow2"), "utf8"), "template disk", "the template is untouched");
  const record = JSON.parse(await readFile(join(dir, "record.json"), "utf8"));
  assert.equal(record.config.image, assets);
  assert.equal(record.config.setup.length, 1);
  assert.equal(record.config.retrySetup, true, "a failed checkout is not kept on the disk");
  assert.match(record.config.setup[0], /git remote set-url origin .*Hello-World\.git.* && git fetch --quiet origin && git checkout --quiet -B .*master.* .*7fd1a60b.* && git -C .*\/home\/user\/workspace\/repo.* update-ref refs\/nexus\/base HEAD/);
  assert.doesNotMatch(record.config.setup[0], / git update-ref/, "update-ref is git's own subcommand");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "intent.json"), "utf8")), { prepare: false });
});

test("a fresh boot clones the pylon's commit and records it as the base its changes are diffed against", async () => {
  const { backend, instances } = await backendWith();
  // The assets are a bare manifest, so the controller fails once it reaches Gondolin.
  await assert.rejects(backend.ensureRunning(bootOf("pylon-fresh"), live, AbortSignal.timeout(60_000)));
  const record = JSON.parse(await readFile(join(instances, "pylon-fresh", "record.json"), "utf8"));
  const clone = (record.config.setup as string[]).find((command) => command.includes("git clone"));
  assert.match(clone!, /git clone --no-checkout .*Hello-World\.git.* && git -C .*repo.* checkout -B .*master.* .*7fd1a60b.* && git -C .*\/home\/user\/workspace\/repo.* update-ref refs\/nexus\/base HEAD/);
  assert.doesNotMatch(clone!, / git update-ref/, "update-ref is git's own subcommand");
});

test("a scratch pylon's setup initializes an empty repository on its branch and fetches nothing", async () => {
  const { backend, instances } = await backendWith();
  const boot = bootOf("pylon-scratch", { source: { kind: "fresh", preSetup: "echo pre-setup" }, repo: { kind: "empty", branch: "trunk" } });
  // No git SSH key on this node, and the HTTPS dotfiles need none, so the boot reaches the controller, which fails at Gondolin.
  await assert.rejects(backend.ensureRunning(boot, live, AbortSignal.timeout(60_000)));
  const { config } = JSON.parse(await readFile(join(instances, "pylon-scratch", "record.json"), "utf8"));
  assert.equal(config.setup.length, 4);
  assert.match(config.setup[0], /^chown user:user /);
  assert.match(config.setup[1], /git init --quiet --initial-branch=.*trunk.* .*\/home\/user\/workspace\/repo/);
  assert.match(config.setup[2], /echo pre-setup/);
  assert.match(config.setup[3], /\.nexus\/setup/);
  assert.ok(config.setup.every((command: string) => !/clone|fetch/.test(command)), "nothing is fetched");
});

test("a scratch pylon's only SSH remote is its dotfiles repository", async () => {
  const { backend } = await backendWith();
  const boot = bootOf("pylon-scratch-ssh", { repo: { kind: "empty", branch: "main" }, dotfiles: { repo: "git@git.example.com:me/dotfiles.git", ref: "main" } });
  await assert.rejects(backend.ensureRunning(boot, live, signal()), { code: "secret-missing", message: "pylon-scratch-ssh uses git.example.com:me/dotfiles.git over SSH, and this node has no git SSH key" });
});

test("a template boot of a scratch pylon is invalid and creates nothing", async () => {
  const { backend, instances } = await backendWith();
  await publishedTemplate("tpl-scratch00000", image);
  const boot = bootOf("pylon-scratch-tpl", { source: { kind: "template", template: "tpl-scratch00000" }, repo: { kind: "empty", branch: "main" } });
  await assert.rejects(backend.ensureRunning(boot, live, signal()), { code: "invalid", message: /pylon-scratch-tpl boots from template tpl-scratch00000, but its project is scratch/ });
  assert.equal(existsSync(join(instances, "pylon-scratch-tpl")), false);
});

test("a template build on an image this node lacks is artifact-missing, and one under 3 GiB is invalid", async () => {
  const { backend, stateRoot } = await backendWith();
  await assert.rejects(backend.buildTemplate("tpl-noimage00000", { ...buildInputs, key: { ...key, image: "img-absent000000" } }, signal()), { code: "artifact-missing", message: /img-absent000000 is not in this node's artifact store/ });
  await assert.rejects(backend.buildTemplate("tpl-small0000000", { ...buildInputs, resources: { cpus: 2, memoryGiB: 2, diskGiB: 8 } }, signal()), { code: "invalid", message: /at least 3 GiB/ });
  assert.equal(existsSync(join(stateRoot, "templates")), false, "no build started");
});

test("a build whose setup failed is setup-failed with its log, publishes nothing and is removed", async () => {
  const { backend, stateRoot } = await backendWith();
  const dir = await leftBuild(stateRoot, "tpl-broken000000", { state: "failed", startupError: "Setup exited 3. Read controller logs. No prepared template was published", startupFailures: [{ kind: "setup", message: "Setup exited 3. Read controller logs. No prepared template was published" }] }, "cloning\nnexus-setup: broken on purpose\n");
  await assert.rejects(backend.buildTemplate("tpl-broken000000", buildInputs, signal()), (err: Error & { code?: string; logTail?: string }) =>
    err.code === "setup-failed" && /Setup exited 3/.test(err.message) && err.logTail?.includes("nexus-setup: broken on purpose") === true);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(join(artifacts, "tpl-broken000000")), false);
  assert.ok(!(await backend.artifacts.list()).includes("tpl-broken000000"));
});

test("a prepared build that a crash left unpublished is published without booting, and its copy removed", { skip: !gnuTar && "publishing hashes a GNU tar archive" }, async () => {
  const { backend, stateRoot } = await backendWith();
  const dir = await leftBuild(stateRoot, "tpl-prepared0000", { state: "prepared" }, "");
  await writeFile(join(dir, "disk.qcow2"), "prepared disk");
  await backend.buildTemplate("tpl-prepared0000", buildInputs, signal());
  assert.equal(existsSync(dir), false);
  assert.equal(await readFile(join(artifacts, "tpl-prepared0000", "disk.qcow2"), "utf8"), "prepared disk");
  const manifest = JSON.parse(await readFile(join(artifacts, "tpl-prepared0000", "template.json"), "utf8"));
  assert.deepEqual([manifest.key, manifest.commit], [key, buildInputs.repo.commit]);
  assert.ok((await backend.artifacts.list()).includes("tpl-prepared0000"));
  await backend.buildTemplate("tpl-prepared0000", buildInputs, signal());
});

test("an image a pylon or a template still needs is not dropped, and a template always is", async () => {
  const { backend, instances } = await backendWith();
  await leftInstance(instances, "pylon-needs", "stopped");
  await publishedTemplate("tpl-dropme000000", image);
  await assert.rejects(backend.artifacts.drop(image), { code: "invalid", message: /img-test00000000 is still needed by pylon pylon-needs, .*template tpl-dropme000000/ });
  assert.ok((await backend.artifacts.list()).includes(image));
  await backend.artifacts.drop("tpl-dropme000000");
  assert.ok(!(await backend.artifacts.list()).includes("tpl-dropme000000"));
});

test("an image is not dropped while a template over it is copied in, and a template over an absent image is not copied", async () => {
  const { backend } = await backendWith();
  const manifest: TemplateManifest = { id: "tpl-arriving0000", key, commit: "c0ffee", builtAt: "2027-01-01T00:00:00.000Z", sha256: "0".repeat(64) };
  const stream = new PassThrough();
  const copying = backend.artifacts.import(manifest, stream, signal());
  await assert.rejects(backend.artifacts.drop(image), { code: "invalid", message: /img-test00000000 is still needed by a pylon or template that is being created or copied in/ });
  stream.destroy(new Error("the peer went away"));
  await assert.rejects(copying, /the peer went away/);
  assert.ok((await backend.artifacts.list()).includes(image));
  await assert.rejects(backend.artifacts.import({ ...manifest, key: { ...key, image: "img-absent000000" } }, Readable.from([]), signal()), { code: "artifact-missing", message: /img-absent000000 is not in this node's artifact store/ });
  assert.ok(!(await backend.artifacts.list()).includes("tpl-arriving0000"));
});

type StartupFailure = { kind: "setup" | "services"; message: string };

/** A controller that answers on the instance's socket that its VM runs with these startup failures. Returns every action but inspect. */
async function failedController(t: import("node:test").TestContext, dir: string, failures: StartupFailure[], setupRecorded: boolean | undefined) {
  const status = { state: "running", startupError: failures.map((f) => f.message).join("\n"), startupFailures: failures, ...(setupRecorded === undefined ? {} : { setupRecorded }) };
  const actions: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      const action = JSON.parse(body) as { action: string; name: string };
      if (action.action !== "inspect") actions.push(action);
      const result = action.action === "inspect"
        ? { name: action.name, labels: { "nexus.image": image }, status: { name: action.name, ...status } }
        : { name: action.name, state: "destroyed" };
      res.end(JSON.stringify(action.action === "inspect" || action.action === "destroy" ? { ok: true, result } : { ok: false, error: `the fake has no ${action.action}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(join(dir, "control.sock"), resolve));
  t.after(() => server.close());
  return actions;
}

const checkoutFailed: StartupFailure = { kind: "setup", message: "Setup exited 128. Read controller logs. No prepared template was published" };
const serviceFailed: StartupFailure = { kind: "services", message: "Service web was not ready within 30 s. Read service logs" };
const fromTemplate = (pylonId: string) => bootOf(pylonId, { source: { kind: "template", template: "tpl-bootable0000" } });

test("a template pylon whose checkout failed on a disk that never finished setup is removed for a retry", async (t) => {
  const { backend, instances } = await backendWith();
  // A controller that died before its first checkpoint was started again, and the checkout it reran could not fetch.
  const dir = await leftInstance(instances, "pylon-recheck", "running", 8, true);
  await writeFile(join(dir, "controller.log"), "fatal: unable to access 'https://github.com/octocat/Hello-World.git/'\n");
  await failedController(t, dir, [checkoutFailed], false);
  await assert.rejects(backend.ensureRunning(fromTemplate("pylon-recheck"), live, signal()), (err: Error & { code?: string; logTail?: string }) =>
    err.code === "backend" && /could not check out its commit on its template's disk, so it was removed/.test(err.message) && err.logTail?.includes("unable to access") === true);
  assert.equal(existsSync(dir), false, "the next spawn boots from the template again");
});

test("a fresh pylon whose setup failed before its first checkpoint is removed, and the failure stays final", async (t) => {
  const { backend, instances } = await backendWith();
  const dir = await leftInstance(instances, "pylon-nosetup", "running");
  await writeFile(join(dir, "controller.log"), "fatal: repository 'https://github.com/ramtinJ95/missing.git/' not found\n");
  await failedController(t, dir, [checkoutFailed], false);
  assert.deepEqual((await backend.list()).map((p) => [p.vm, p.cause]), [["broken", "setup"]]);
  await assert.rejects(backend.ensureRunning(bootOf("pylon-nosetup"), live, signal()), (err: Error & { code?: string; logTail?: string }) =>
    err.code === "setup-failed" && /Setup exited 128.*had no checkpoint, so it was removed, and a retry boots the pylon fresh/.test(err.message) && err.logTail?.includes("repository 'https://github.com/ramtinJ95/missing.git/' not found") === true);
  assert.equal(existsSync(dir), false, "a retry finds the pylon absent and boots it fresh, running setup again");
});

test("every other startup failure is final, carries the controller log's tail, and keeps the pylon, the user's work on it included", async (t) => {
  const { backend, instances } = await backendWith();
  const kept: [string, boolean, StartupFailure[], boolean | undefined, RegExp, BrokenCause][] = [
    ["a project's failed setup recorded on a disk that has a checkpoint", false, [checkoutFailed], true, /Setup exited 128/, "saved-setup"],
    ["a service that failed on a fresh pylon's first boot", false, [serviceFailed], false, /Service web was not ready/, "services"],
    ["a service that failed on a template pylon woken from its checkpoint", true, [serviceFailed], true, /Service web was not ready/, "services"],
    ["a setup failure on a template pylon whose disk finished setup once", true, [checkoutFailed], true, /Setup exited 128/, "saved-setup"],
    ["a service that failed after the checkout of a template boot", true, [serviceFailed], false, /Service web was not ready/, "services"],
    ["a template pylon whose controller does not report setupRecorded", true, [checkoutFailed], undefined, /Setup exited 128/, "setup"],
    ["a setup failure on a disk that has a checkpoint but did not hold the failure when it booted", false, [checkoutFailed], false, /Setup exited 128/, "saved-setup"],
  ];
  for (const [i, [what, retrySetup, failures, setupRecorded, message, cause]] of kept.entries()) {
    const pylonId = `pylon-kept-${i}`;
    const dir = await leftInstance(instances, pylonId, "running", 8, retrySetup);
    if (i === 0 || i === 6) await writeFile(join(dir, "disk.qcow2"), "a completed stop's disk");
    await writeFile(join(dir, "controller.log"), "npm ERR! 404 left-pad\n");
    await failedController(t, dir, failures, setupRecorded);
    await assert.rejects(backend.ensureRunning(retrySetup ? fromTemplate(pylonId) : bootOf(pylonId), live, signal()), { code: "setup-failed", message, logTail: /npm ERR! 404 left-pad/ }, what);
    assert.equal(existsSync(dir), true, what);
    const listed = (await backend.list()).find((p) => p.pylonId === pylonId);
    assert.deepEqual([listed?.vm, listed?.cause], ["broken", cause], what);
  }
});

test("pausing a VM whose setup failed before its first checkpoint removes it, so its next boot runs setup again", async (t) => {
  const { backend, instances } = await backendWith();
  const dir = await leftInstance(instances, "pylon-pausefresh", "running");
  const actions = await failedController(t, dir, [checkoutFailed], false);
  await backend.ensurePaused("pylon-pausefresh" as PylonId, "ckpt-pausefresh-1", signal());
  assert.deepEqual(actions.map((a) => a.action), ["destroy"], "the guest records no sessions and the disk is not saved");
  assert.equal(existsSync(dir), false);
  assert.deepEqual(await backend.list(), [], "the pylon reads absent, and the planner spawns it fresh");
});

test("a VM whose setup failed on a disk that has a checkpoint is not paused, so the failure is never saved", async (t) => {
  const { backend, instances } = await backendWith();
  const dir = await leftInstance(instances, "pylon-pausesaved", "running");
  await writeFile(join(dir, "disk.qcow2"), "the last completed disk");
  await writeFile(join(dir, "nexus-checkpoint.json"), JSON.stringify({ checkpoint: "ckpt-pausesaved-1" }));
  const actions = await failedController(t, dir, [checkoutFailed], true);
  assert.deepEqual((await backend.list()).map((p) => [p.vm, p.cause]), [["broken", "saved-setup"]], "the planner refuses it, and never asks for this pause");
  await assert.rejects(backend.ensurePaused("pylon-pausesaved" as PylonId, "ckpt-pausesaved-2", signal()), { code: "setup-failed", message: /A pause would save the failed setup onto its disk, so it is not paused\. Start again from the project/ });
  assert.deepEqual(actions, [], "nothing was stopped, recorded or removed");
  assert.equal(await readFile(join(dir, "disk.qcow2"), "utf8"), "the last completed disk");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "nexus-checkpoint.json"), "utf8")), { checkpoint: "ckpt-pausesaved-1" });
});

test("a VM whose controller predates startupFailures is broken for an unknown reason and is not paused", async (t) => {
  const { backend, instances } = await backendWith();
  const dir = await leftInstance(instances, "pylon-legacy", "running");
  // Such a controller reports only the startupError, which may be a setup that failed partway.
  const status = { state: "running", startupError: "Setup exited 128. Read controller logs" };
  const actions: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      const action = JSON.parse(body) as { action: string; name: string };
      if (action.action !== "inspect") actions.push(action);
      res.end(JSON.stringify(action.action === "inspect"
        ? { ok: true, result: { name: action.name, labels: { "nexus.image": image }, status: { name: action.name, ...status } } }
        : { ok: false, error: `the fake has no ${action.action}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(join(dir, "control.sock"), resolve));
  t.after(() => server.close());
  assert.deepEqual((await backend.list()).map((p) => [p.vm, p.cause]), [["broken", "unknown"]], "the planner refuses it, and never asks for this pause");
  await assert.rejects(backend.ensurePaused("pylon-legacy" as PylonId, "ckpt-legacy-1", signal()), { code: "setup-failed", message: /does not say whether setup failed.*so it is not paused\. Start again from the project/ });
  assert.deepEqual(actions, [], "nothing was stopped, recorded or removed");
  assert.equal(existsSync(join(dir, "disk.qcow2")), false);
  assert.equal(existsSync(join(dir, "nexus-checkpoint.json")), false);
});
