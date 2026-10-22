/**
 * What the pylon VM backend decides before it boots anything, and how it pauses an instance whose controller
 * died. No VM runs here: a boot that reached Gondolin would fail, so every test stops short of one. The real
 * boot path is checked by the slice test on a node (NEXUS_SLICE_BACKEND=pylon-vm).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPylonVmBackend, type PylonVmBackendOptions } from "./pylon-vm-backend.ts";
import type { BootInputs } from "./project.ts";
import type { PylonId } from "./protocol.ts";
import type { ImageId } from "./images.ts";

// Under /tmp, not os.tmpdir(): macOS's per-user temp dir is too long for the controllers' Unix sockets.
const scratch = await mkdtemp("/tmp/nexus-pvb-");
after(() => rm(scratch, { recursive: true, force: true }));

const image: ImageId = "img-test00000000";
const assets = join(scratch, "assets");
await mkdir(assets);
await writeFile(join(assets, "manifest.json"), "{}");
const live = { previews: [], overlay: [] };

let roots = 0;
async function backendWith(extra: Partial<PylonVmBackendOptions> = {}) {
  const stateRoot = join(scratch, `state-${roots++}`);
  await mkdir(join(stateRoot, "instances"), { recursive: true, mode: 0o700 });
  const backend = createPylonVmBackend({ stateRoot, images: { [image]: assets }, secrets: { value: () => undefined }, ...extra });
  return { backend, instances: join(stateRoot, "instances") };
}

function bootOf(pylonId: string, changes: Partial<BootInputs> = {}): BootInputs {
  return {
    pylonId: pylonId as PylonId,
    image,
    source: { kind: "fresh", preSetup: null },
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 8 },
    network: { allowedHosts: ["github.com"], secrets: [] },
    repo: { url: "https://github.com/octocat/Hello-World.git", checkout: { branch: "master", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" } },
    dotfiles: { repo: "https://github.com/octocat/Spoon-Knife.git", ref: "main" },
    ...changes,
  };
}

/** What a pi-sandbox-format instance looks like on disk after its controller died or stopped. */
async function leftInstance(instances: string, pylonId: string, state: "stopped" | "running" | "starting", diskGiB = 8) {
  const dir = join(instances, pylonId);
  await mkdir(dir, { mode: 0o700 });
  const config = { version: 1, diskGiB, image: assets, workspace: "/home/user/workspace", setup: [], resume: [], services: {} };
  await writeFile(join(dir, "record.json"), JSON.stringify({ version: 1, name: pylonId, config, createdAt: "2026-10-22T00:00:00Z", labels: { "nexus.image": image } }));
  await writeFile(join(dir, "status.json"), JSON.stringify({ name: pylonId, state }));
  return dir;
}

const signal = () => AbortSignal.timeout(10_000);

test("a state root too long for a pylon's control socket is refused when the backend is created", () => {
  const stateRoot = `/var/lib/${"n".repeat(40)}`;
  assert.throws(() => createPylonVmBackend({ stateRoot, images: {}, secrets: { value: () => undefined } }), /a pylon's control socket would be 113 bytes, and a Unix socket path must stay under 104/);
  createPylonVmBackend({ stateRoot: "/var/lib/nexus/pylons", images: {}, secrets: { value: () => undefined } });
});

test("an SSH repo on a node without a git SSH key fails as secret-missing and creates nothing", async () => {
  const { backend, instances } = await backendWith();
  const boot = bootOf("pylon-ssh", { repo: { url: "git@github.com:acme/web.git", checkout: { branch: "main", commit: "c0ffee" } } });
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
  await assert.rejects(backend.ensureRunning(bootOf("pylon-flat", { repo: { url: "git@git.example.com:web.git", checkout } }), live, signal()), { code: "invalid", message: /has no owner in its path/ });
  const twoUsers = bootOf("pylon-users", { repo: { url: "alice@git.example.com:acme/web.git", checkout }, dotfiles: { repo: "bob@git.example.com:bob/dotfiles.git", ref: "main" } });
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
    repo: { url: "git@github.com:acme/web.git", checkout: { branch: "main", commit: "c0ffee" } },
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
  const boot = bootOf("pylon-url", { repo: { url: "file:///srv/repo.git", checkout: { branch: "main", commit: "c0ffee" } } });
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
  assert.deepEqual((await backend.list()).map((p) => [p.pylonId, p.vm]), [["pylon-dead", "broken"]]);
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
  await writeFile(join(dir, "launch.lock", "owner"), `${process.pid}\n`);
  assert.deepEqual((await backend.list()).map((p) => p.vm), ["booting"]);
  await rm(join(dir, "launch.lock"), { recursive: true });
  assert.deepEqual((await backend.list()).map((p) => p.vm), ["broken"]);
});
