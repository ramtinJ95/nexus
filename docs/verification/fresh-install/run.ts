/**
 * A new person's install of Nexus, from nothing, on three fresh Debian 12 machines: the Linux machine, fresh-box, a
 * stand-in for their Mac, fresh-mac, and a second Linux machine, fresh-node, which joins as a node. Run it as root from a checkout, which it installs at its HEAD commit:
 *
 *   sudo node docs/verification/fresh-install/run.ts
 *
 * Each machine is Debian's official bookworm root filesystem in its own mount, PID, UTS and IPC namespaces. On
 * fresh-box the person runs deploy/install.sh, fixes what its prerequisite check reports, and runs it again with
 * the agents' credentials as test values, in its non-interactive mode. On fresh-mac they run deploy/mac/install and
 * the `nexus connect` the installer printed, and start a thread, which fresh-box's probe tries to boot. No pylon boots
 * here, so the thread never answers. Then fresh-node joins with a token minted on fresh-box. The README in this directory names every stand-in and what the run cannot check.
 * Everything the run made is removed at its end, and at the start of the next run.
 */
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { host, startTailnet, status, type Device } from "./tailnet.ts";

const exec = promisify(execFile);
const here = new URL(".", import.meta.url).pathname;
const repo = join(here, "../../..");
const work = "/var/tmp/nexus-fresh-install";
const cache = "/var/cache/nexus-fresh-install";

/** Debian's bookworm image as docker-library builds it, from the commit of debuerreotype's artifacts this run pins. */
const rootfs = {
  repo: "https://github.com/debuerreotype/docker-debian-artifacts.git",
  commit: "69faaf492e77aff83e4c7fc401017c9d25ecde24",
  path: "bookworm/oci/blobs/rootfs.tar.gz",
  sha256: "a4aa977c0d0eb2336dad68941e458308ebf32a717c19ea72e475b9eda8035506",
};

const box: Device = { id: "nFRESHBOX0001", name: "fresh-box", ip: "100.77.0.1", root: join(work, "fresh-box") };
const mac: Device = { id: "nFRESHMAC0001", name: "fresh-mac", ip: "100.77.0.2", root: join(work, "fresh-mac") };
const node: Device = { id: "nFRESHNODE001", name: "fresh-node", ip: "100.77.0.3", root: join(work, "fresh-node") };
const devices = [box, mac, node];
/** Where the machines find OpenAI and GitHub's API: nowhere, so the test's credentials never leave this host. */
const blackhole = "127.0.0.9";
/** The CA of the TLS proxy a Nexus pylon's egress goes through, when this runs in one. */
const egressCa = "/usr/local/share/ca-certificates/gondolin-mitm-ca.crt";
const dotfiles = "https://github.com/ramtinJ95/dotfiles.git";
const credentials = {
  NEXUS_HARNESS_LOGIN: "api-key",
  NEXUS_OPENAI_API_KEY: "sk-fresh-install-test",
  NEXUS_CLAUDE_TOKEN: "sk-ant-oat01-fresh-install-test",
  NEXUS_GH_TOKEN: "github_pat_fresh_install_test",
};

const say = (line: string) => console.log(line);
const indent = (text: string) => text.trimEnd().split("\n").map((l) => `    ${l}`).join("\n");
const step = (title: string) => say(`\n== ${title}`);

interface Run { code: number; out: string }

/** A machine: its root, and the PID 1 of its namespaces, which every command enters. */
class Machine {
  readonly device: Device;
  readonly pid: number;
  constructor(device: Device, pid: number) {
    this.device = device;
    this.pid = pid;
  }

  /** As root, or as the person with a login shell. stdout and stderr together, as a terminal shows them. */
  run(command: string, options: { as?: "root" | "person"; env?: Record<string, string>; quiet?: boolean } = {}): Promise<Run> {
    const env = Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const line = env.length === 0 ? command : `export ${env.join(" ")}; ${command}`;
    // A login shell, as over SSH, which starts from a clean environment.
    const shell = options.as === "root" ? ["/bin/bash", "-c", line] : ["/usr/sbin/runuser", "-l", "person", "-c", line];
    const args = ["--target", String(this.pid), "--mount", "--uts", "--ipc", "--pid", "--root", "--wd", "--", "/usr/bin/env", "-i", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "TERM=dumb", ...shell];
    if (!options.quiet) say(`${this.device.name}${options.as === "root" ? "#" : "$"} ${line}`);
    return new Promise((resolve, reject) => {
      const child = spawn("nsenter", args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (b: Buffer) => { out += b; });
      child.stderr.on("data", (b: Buffer) => { out += b; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (!options.quiet && out.trim() !== "") say(indent(out));
        if (!options.quiet) say(`    (exit ${code})`);
        resolve({ code: code ?? 1, out });
      });
    });
  }

  async ok(command: string, options: Parameters<Machine["run"]>[1] = {}): Promise<string> {
    const { code, out } = await this.run(command, options);
    assert.equal(code, 0, `${this.device.name}: ${command} exited ${code}`);
    return out;
  }
}

async function fetchRootfs(): Promise<string> {
  const tarball = join(cache, `${rootfs.sha256}.tar.gz`);
  if (!existsSync(tarball)) {
    const clone = join(cache, "artifacts");
    await rm(clone, { recursive: true, force: true });
    await exec("git", ["init", "-q", clone]);
    await exec("git", ["-C", clone, "fetch", "-q", "--depth=1", "--filter=blob:none", rootfs.repo, rootfs.commit]);
    await exec("git", ["-C", clone, "sparse-checkout", "set", "--no-cone", `/${rootfs.path}`]);
    await exec("git", ["-C", clone, "checkout", "-q", "FETCH_HEAD"], { maxBuffer: 1 << 20 });
    await cp(join(clone, rootfs.path), tarball);
    await rm(clone, { recursive: true, force: true });
  }
  const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
  assert.equal(digest, rootfs.sha256, `${tarball} is not the pinned rootfs`);
  return tarball;
}

/**
 * One run at a time on this host, since each sweeps the previous one's machines: the run goes on under flock, whose
 * lock the kernel drops with the process, so a run that died never holds it.
 */
function runLocked(): void {
  const lockFile = join(cache, "lock");
  if (process.env.NEXUS_FRESH_INSTALL_LOCKED === lockFile) return;
  mkdirSync(cache, { recursive: true });
  const run = spawnSync("flock", ["--nonblock", "--conflict-exit-code", "75", lockFile, process.execPath, ...process.argv.slice(1)], {
    stdio: "inherit", env: { ...process.env, NEXUS_FRESH_INSTALL_LOCKED: lockFile },
  });
  if (run.status === 75) say("FAIL: another fresh-install run holds the lock");
  process.exit(run.status ?? 1);
}

/** The tailnet addresses, which the probe insists on, on this host's loopback interface. */
const addresses = (state: "up" | "down") => Promise.all(devices.map((d, i) => exec("python3", [join(here, "loopback.py"), `lo:fi${i}`, d.ip, state]).catch((err: Error) => {
  if (state === "up") throw err;
})));

/** Kills every process of a machine, this run's or a previous one's, and removes what the runs made. */
async function sweep(): Promise<void> {
  for (const pid of (await readdir("/proc")).filter((p) => /^\d+$/.test(p))) {
    if (!(await readlink(`/proc/${pid}/root`).catch(() => "")).startsWith(`${work}/`)) continue;
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }
  await delay(500);
  await rm(work, { recursive: true, force: true });
  await addresses("down");
}

const devNodes = "mknod -m 666 dev/null c 1 3 && mknod -m 666 dev/zero c 1 5 && mknod -m 666 dev/full c 1 7 && mknod -m 666 dev/random c 1 8 && mknod -m 666 dev/urandom c 1 9 && mknod -m 666 dev/tty c 5 0 && mkdir dev/pts dev/shm && mount -t devpts -o newinstance,ptmxmode=0666 devpts dev/pts && ln -s pts/ptmx dev/ptmx && ln -s /proc/self/fd dev/fd";

/** Unpacks Debian, gives it a hostname, MagicDNS's names and a sudoer named person, and starts its PID 1. */
async function boot(d: Device, tarball: string, hosts: string): Promise<Machine> {
  await mkdir(d.root, { recursive: true });
  await exec("tar", ["-C", d.root, "-xzf", tarball]);
  await writeFile(join(d.root, "etc/hostname"), `${d.name}\n`);
  await writeFile(join(d.root, "etc/hosts"), `127.0.0.1 localhost\n${hosts}`);
  await cp("/etc/resolv.conf", join(d.root, "etc/resolv.conf"), { dereference: true });
  const init = `cd ${d.root} && mount -t proc proc proc && mount -t sysfs -o ro sysfs sys && mount -t tmpfs -o mode=755 tmpfs dev && ${devNodes} && mount -t tmpfs -o mode=1777 tmpfs tmp && hostname ${d.name} && exec chroot . /bin/bash -c 'trap "exit 0" TERM; while :; do sleep 1 & wait $!; done'`;
  const child = spawn("unshare", ["--mount", "--uts", "--ipc", "--pid", "--fork", "--propagation", "private", "/bin/bash", "-c", init], { stdio: "ignore", detached: true });
  child.unref();
  let pid = 0;
  for (let i = 0; i < 100 && pid === 0; i++) {
    await delay(50);
    const children = await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").catch(() => "");
    const candidate = Number(children.trim().split(/\s+/)[0] ?? 0);
    if (candidate > 0 && (await readlink(`/proc/${candidate}/root`).catch(() => "")) === d.root) pid = candidate;
  }
  assert.ok(pid > 0, `${d.name} did not boot`);
  const machine = new Machine(d, pid);
  await standIn(d, "apt-get", "sudo", "openssh-client");
  await machine.ok("useradd --create-home --shell /bin/bash person && echo 'person ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/person", { as: "root", quiet: true });
  return machine;
}

/** The checkout's HEAD as the main branch of a repository the person owns in the machine, to clone as from GitHub. */
async function publish(d: Device): Promise<void> {
  const bare = join(d.root, "srv/nexus.git");
  await exec("git", ["init", "-q", "--bare", "-b", "main", bare]);
  await exec("git", ["-C", repo, "push", "-q", bare, "HEAD:refs/heads/main"]);
  await exec("chown", ["-R", "1000:1000", bare]);
}

/** Runs a stand-in from ./standin on the host, against the machine's root. */
const standIn = (d: Device, name: string, ...args: string[]) => exec(join(here, "standin", name), [d.root, ...args]);

/** systemd, which the machine cannot boot. Debian with systemd has these directories, and the installer looks for the first. */
async function installSystemd(m: Machine): Promise<void> {
  for (const dir of ["run/systemd/system", "etc/systemd/system", "lib/systemd/system"]) await mkdir(join(m.device.root, dir), { recursive: true });
  for (const name of ["systemctl", "journalctl"]) await cp(join(here, "standin", name), join(m.device.root, "usr/bin", name));
}

/**
 * This host's Node 26 and npm, as NodeSource's nodejs package would put them, with the C++ runtime it links. When
 * this runs in a pylon, the npm registry is behind the sandbox's TLS proxy: npm trusts the proxy's CA, and gives each
 * connection 5 seconds rather than Node's 250 ms per address family, which the proxy misses under npm's load, and retries more.
 */
async function installNode(m: Machine): Promise<void> {
  const { root } = m.device;
  await standIn(m.device, "apt-get", "libstdc++6", "libatomic1");
  await cp(process.execPath, join(root, "usr/bin/node"));
  await cp(npmPackage()!, join(root, "usr/lib/node_modules/npm"), { recursive: true });
  await m.ok("ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/bin/npx", { as: "root", quiet: true });
  if (!existsSync(egressCa)) {
    await m.ok("ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/bin/npm", { as: "root", quiet: true });
    return;
  }
  await cp(egressCa, join(root, "usr/local/share/egress-ca.pem"));
  await mkdir(join(root, "usr/etc"), { recursive: true });
  await writeFile(join(root, "usr/etc/npmrc"), "cafile=/usr/local/share/egress-ca.pem\nfetch-retries=6\n");
  await writeFile(join(root, "usr/bin/npm"), '#!/bin/sh\nexec node --network-family-autoselection-attempt-timeout=5000 /usr/lib/node_modules/npm/bin/npm-cli.js "$@"\n', { mode: 0o755 });
}

/** npm's package beside the Node that runs this, where Node's own tarball or NodeSource's package puts it. */
function npmPackage(): string | undefined {
  const prefix = dirname(dirname(process.execPath));
  return [join(prefix, "lib/node_modules/npm"), "/usr/lib/node_modules/npm", "/usr/share/nodejs/npm"].find((dir) => existsSync(join(dir, "bin/npm-cli.js")));
}

/** The Debian packages the apt-get stand-in copies into the machines, with every dependency it follows. */
const hostPackages = ["sudo", "openssh-client", "git", "libstdc++6", "libatomic1"];

/** Refuses a host the run cannot use, before it changes anything there. */
async function preflight(): Promise<void> {
  const missing: string[] = [];
  for (const tool of ["git", "tar", "unshare", "nsenter", "flock", "python3", "dpkg-query", "runuser"]) {
    if ((await exec("sh", ["-c", `command -v ${tool}`]).catch(() => null)) === null) missing.push(`the ${tool} command`);
  }
  if (Number(process.versions.node.split(".")[0]) < 26) missing.push(`Node 26 or newer, not ${process.version}`);
  if (npmPackage() === undefined) missing.push(`npm's package beside ${process.execPath}`);
  const debian = await readFile("/etc/debian_version", "utf8").catch(() => "");
  if (!debian.startsWith("12.")) missing.push("Debian 12, whose packages the machines get");
  else {
    const status = await exec("dpkg-query", ["-W", "-f=${Package} ${db:Status-Status}\\n", ...hostPackages]).then((r) => r.stdout, (err: { stdout?: string }) => err.stdout ?? "");
    for (const name of hostPackages) if (!status.split("\n").includes(`${name} installed`)) missing.push(`the Debian package ${name}`);
  }
  assert.equal(missing.length, 0, `this host lacks ${missing.join(", ")}. Install them, then run again`);
}

/** What the installer printed under one prerequisite it found missing, as the commands to run. */
function fixFor(output: string, missing: RegExp): string[] {
  const lines = output.split("\n");
  const at = lines.findIndex((l) => l.startsWith("- ") && missing.test(l));
  assert.ok(at >= 0, `the installer did not report ${missing}`);
  const fix: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("    ")) break;
    fix.push(line.trim());
  }
  return fix;
}

async function main(): Promise<void> {
  assert.equal(process.getuid?.(), 0, "run as root: sudo node docs/verification/fresh-install/run.ts");
  runLocked();
  await preflight();
  const commit = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  const dirty = (await exec("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no", "--", ".", ":!docs/verification/fresh-install/transcript.txt"])).stdout.trim() !== "";
  say(`Fresh install of Nexus at ${commit}${dirty ? ", without the checkout's uncommitted changes" : ""}`);
  const cleanups: (() => Promise<unknown>)[] = [sweep];
  let cleaning: Promise<void> | undefined;
  const cleanUp = () => cleaning ??= (async () => {
    for (const c of cleanups) await c().catch((err: Error) => say(`cleanup: ${err.message}`));
  })();
  // A signal's cleanup kills the command in flight, so main's own cleanup and failure must wait for it, not exit first.
  const stop = (code: number) => void cleanUp().then(() => process.exit(code));
  process.once("SIGINT", () => stop(130));
  process.once("SIGTERM", () => stop(143));

  const booted: Machine[] = [];
  try {
    await sweep();
    await mkdir(work, { recursive: true });
    await addresses("up");
    const tarball = await fetchRootfs();
    const hosts = devices.map((d) => `${d.ip} ${host(d)} ${d.name}\n`).join("") + `${blackhole} api.openai.com api.github.com\n`;
    const machines = new Map<string, Device>();
    const tailnet = await startTailnet(devices, () => machines, work);
    cleanups.unshift(() => tailnet.close());

    step("Three fresh Debian machines");
    const b = await boot(box, tarball, hosts);
    const m = await boot(mac, tarball, hosts);
    const n = await boot(node, tarball, hosts);
    booted.push(b, n);
    for (const machine of [b, m, n]) machines.set(await readlink(`/proc/${machine.pid}/ns/pid`), machine.device);
    for (const machine of [b, n]) await installSystemd(machine);
    await b.ok("cat /etc/debian_version && id person");

    step("fresh-box: the person clones Nexus");
    for (const d of devices) await publish(d);
    say("stand-in for `sudo apt-get install -y git`, from this host's Debian packages:");
    say(indent((await standIn(box, "apt-get", "git")).stdout));
    await b.ok("git clone -q /srv/nexus.git nexus && git -C nexus log -1 --format='%H on %D'");

    const install = `cd nexus && sudo deploy/install.sh --admit ${mac.name} --dotfiles ${dotfiles}`;
    step("fresh-box: the first run checks the prerequisites and changes nothing");
    const first = await b.run(install);
    assert.equal(first.code, 1, "the first run fails on the missing prerequisites");
    assert.ok(!existsSync(join(box.root, "etc/nexus")), "the first run wrote no config");

    step("fresh-box: the person fixes each prerequisite it named");
    say(`Node: ${fixFor(first.out, /Node 26/).join(" ")}`);
    say("  stand-in: this host's Node 26 and npm, since this host reaches no NodeSource repository");
    await installNode(b);
    say(`QEMU: ${fixFor(first.out, /QEMU VMs/).join(" ")}`);
    say("  stand-in: qemu-system-x86_64 and qemu-img that fail, since this host has no KVM to run a pylon");
    for (const name of ["qemu-system-x86_64", "qemu-img"]) await cp(join(here, "standin/qemu"), join(box.root, "usr/bin", name));
    say(`KVM: ${fixFor(first.out, /\/dev\/kvm/).join(" ")}`);
    say("  stand-in: a /dev/kvm device node in the kvm group, which nothing opens, since this host has no KVM");
    await b.ok("groupadd --system --force kvm && mknod -m 660 /dev/kvm c 10 232 && chgrp kvm /dev/kvm", { as: "root" });
    const tailscaleFix = fixFor(first.out, /Tailscale is not installed/);
    say(`Tailscale: ${tailscaleFix.join(" && ")}`);
    say("  stand-in: a tailscale CLI and a tailscaled unit for the made-up tailnet, whose LocalAPI this test serves");
    await installTailscale(b);
    await b.ok(tailscaleFix.at(-1)!);

    step("fresh-box: the second run finds what the first could not check");
    const second = await b.run(install);
    assert.equal(second.code, 1, "the second run still misses tailscaled's certificate permission");
    const certFix = fixFor(second.out, /TS_PERMIT_CERT_UID|fetch the dashboard's certificate/);
    for (const command of certFix) await b.ok(command);

    step("fresh-box: the third run installs, with the credentials as test values");
    say("stand-in for `ssh-keyscan github.com`, which this host cannot reach on port 22: the host keys api.github.com/meta publishes");
    await cp(join(here, "standin/github-host-keys"), join(box.root, "usr/local/share/standin-github-host-keys"));
    await cp(join(here, "standin/ssh-keyscan"), join(box.root, "usr/local/bin/ssh-keyscan"));
    const env = Object.entries(credentials).map(([k, v]) => `${k}=${v}`).join(" ");
    const third = await b.run(`cd nexus && sudo env ${env} deploy/install.sh --admit ${mac.name} --dotfiles ${dotfiles} --non-interactive`);
    assert.equal(third.code, 0, "the install succeeds");
    for (const unit of ["nexus-control", "nexus-probe"]) await b.ok(`systemctl is-active ${unit}`);
    const secrets = await b.ok("sudo cut -d= -f1 /etc/nexus/secrets.env | grep -v '^#'");
    assert.match(secrets, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(secrets, /GH_TOKEN/);
    await b.ok("sudo cat /etc/nexus/git_ed25519.pub && sudo grep -c gitSsh /etc/nexus/probe.json");
    const connect = /nexus connect (\S+)/.exec(third.out)?.[1];
    assert.ok(connect !== undefined, "the installer says how to connect the Mac");
    const pids = "systemctl show nexus-control --property=MainPID --value && systemctl show nexus-probe --property=MainPID --value";
    const running = await b.ok(pids);

    step("fresh-mac: the person installs the CLI and connects");
    say("stand-in for Node 26 from Homebrew and git from Xcode's tools: this host's Node and Debian's git");
    await installNode(m);
    await standIn(mac, "apt-get", "git");
    await m.ok("git clone -q /srv/nexus.git nexus && nexus/deploy/mac/install");
    say("stand-in for the public CA that signs tailscaled's certificates: this run's own, trusted through NODE_EXTRA_CA_CERTS");
    await writeFile(join(mac.root, "home/person/tailnet-ca.pem"), tailnet.certificates.get(host(box))!.cert);
    const cli = { NODE_EXTRA_CA_CERTS: "/home/person/tailnet-ca.pem" };
    const connected = await m.ok(`export PATH=$HOME/.local/bin:$PATH && nexus connect ${connect}`, { env: cli });
    assert.match(connected, new RegExp(`Connected to https://${host(box).replaceAll(".", "\\.")}:7443`));
    assert.match(connected, / may start and message threads/);
    assert.match(connected, / may deploy/);

    step("fresh-box and fresh-mac: the first image");
    say("stand-in for `nexus image build --wait`, which needs Docker and builds for 8 minutes: an image's directory");
    say("in fresh-box's artifact store, recorded through the API, which no pylon can boot");
    const image = await placeImage(b);
    await m.ok(`node -e 'fetch(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.config/nexus/cli.json")).url + "/v1/images", { method: "POST", headers: { "content-type": "application/json" }, body: process.argv[1] }).then(async (r) => { console.log(r.status); if (!r.ok) process.exit(1); })' '${image}'`, { env: cli });
    const id = (JSON.parse(image) as { id: string }).id;
    say("fresh-mac$ nexus image rollout until fresh-box's probe reports the image it holds");
    const rolledOut = await until("fresh-box's probe reports the image", () => m.run(`$HOME/.local/bin/nexus image rollout ${id} --wait`, { env: cli, quiet: true }), 120_000);
    say(indent(rolledOut.out));

    step("fresh-mac: a first thread starts, and fresh-box's probe tries to boot its pylon");
    const nexus = (args: string) => m.ok(`$HOME/.local/bin/nexus ${args}`, { env: cli });
    say("a project that fits this host, whose machines have less memory than a project's default 6 GiB");
    await nexus("project add hello --scratch --cpus 1 --memory 3 --disk 2");
    const thread = (JSON.parse(await nexus("start --project hello --title 'First thread' --message 'hello from a fresh install' --json")) as { id: string; placement: { node: string } });
    assert.equal(thread.placement.node, box.name, "the thread is placed on fresh-box");
    const shown = await until("the probe reports the pylon's boot", async () => {
      const run = await m.run(`$HOME/.local/bin/nexus show ${thread.id}`, { env: cli, quiet: true });
      return { code: run.code === 0 && /^failed: /m.test(run.out) ? 0 : 1, out: run.out };
    }, 300_000);
    say(indent(shown.out));
    assert.match(shown.out, /Missing guest assets in \/var\/lib\/nexus\/artifacts\/img-/, "the VM backend refused only the stand-in image");

    step("fresh-node: the admin adds a machine with a join token");
    const minted = await b.ok("cd nexus && sudo deploy/install.sh --join-token");
    const joinCommand = /sudo deploy\/install\.sh --join \S+ --node \S+/.exec(minted)?.[0];
    assert.ok(joinCommand !== undefined, "--join-token prints the command for the new machine");
    say("fresh-node has the prerequisites fresh-box was given above, with the same stand-ins");
    await installNode(n);
    for (const name of ["qemu-system-x86_64", "qemu-img"]) await cp(join(here, "standin/qemu"), join(node.root, "usr/bin", name));
    await n.ok("groupadd --system --force kvm && mknod -m 660 /dev/kvm c 10 232 && chgrp kvm /dev/kvm", { as: "root", quiet: true });
    await installTailscale(n);
    await cp(join(here, "standin/github-host-keys"), join(node.root, "usr/local/share/standin-github-host-keys"));
    await cp(join(here, "standin/ssh-keyscan"), join(node.root, "usr/local/bin/ssh-keyscan"));
    await standIn(node, "apt-get", "git");
    await n.ok("git clone -q /srv/nexus.git nexus");
    say("stand-in: fresh-node's preview gateway on port 7491, since it shares fresh-box's 127.0.0.1, where fresh-box's takes 7481");
    await mkdir(join(node.root, "etc/nexus"), { recursive: true });
    await writeFile(join(node.root, "etc/nexus/probe.json"), `${JSON.stringify({ previews: { gatewayPort: 7491 } })}\n`);
    const nodeCredentials = `NEXUS_CLAUDE_TOKEN=${credentials.NEXUS_CLAUDE_TOKEN} NEXUS_GH_TOKEN=${credentials.NEXUS_GH_TOKEN}`;
    const joined = await n.run(`cd nexus && ${joinCommand.replace("sudo ", `sudo env ${nodeCredentials} `)} --non-interactive`);
    assert.equal(joined.code, 0, "the join succeeds");
    assert.match(joined.out, new RegExp(`joined the control plane as node ${node.name}`));
    await n.ok("systemctl is-active nexus-probe");
    const nodes = await until("the control plane follows fresh-node's probe", async () => {
      const run = await m.run("$HOME/.local/bin/nexus nodes", { env: cli, quiet: true });
      return { code: new RegExp(`^${node.name}\\b.*online`, "m").test(run.out) ? 0 : 1, out: run.out };
    }, 120_000);
    say("fresh-mac$ nexus nodes");
    say(indent(nodes.out));
    assert.equal(await b.ok(pids), running, "the control plane followed the new node without a restart");

    step("fresh-box: a rerun changes nothing");
    const before = await b.ok(pids);
    const rerun = await b.run(`cd nexus && sudo deploy/install.sh --non-interactive`);
    assert.equal(rerun.code, 0, "the rerun succeeds");
    assert.doesNotMatch(rerun.out, /^(wrote|updated) /m, "the rerun writes no config");
    assert.equal(await b.ok(pids), before, "no service restarted");

    step("PASS");
  } catch (err) {
    step("What the services logged");
    for (const machine of booted) for (const unit of ["nexus-control", "nexus-probe"]) await machine.run(`journalctl -u ${unit} -n 40`, { as: "root" }).catch(() => undefined);
    throw err;
  } finally {
    await cleanUp();
    say(existsSync(work) ? `cleanup left ${work}` : `cleaned up ${work}`);
  }
}

/** Retries `attempt` until it exits 0, and returns that run. */
async function until(what: string, attempt: () => Promise<Run>, timeoutMs: number): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await attempt();
    if (run.code === 0) return run;
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}:\n${run.out}`);
    await delay(2000);
  }
}

/** The tailscale CLI, a tailscaled unit that runs while the test serves its LocalAPI, and the tailnet it reports. */
async function installTailscale(m: Machine): Promise<void> {
  const { root } = m.device;
  await cp(join(here, "standin/tailscale"), join(root, "usr/bin/tailscale"));
  await writeFile(join(root, "usr/sbin/tailscaled"), "#!/bin/sh\n# Stands in for tailscaled, whose LocalAPI the fresh-install test serves from the host.\nexec sleep infinity\n");
  await chmod(join(root, "usr/sbin/tailscaled"), 0o755);
  await writeFile(join(root, "lib/systemd/system/tailscaled.service"), "[Unit]\nDescription=Tailscale node agent (stand-in)\n\n[Service]\nExecStart=/usr/sbin/tailscaled\n\n[Install]\nWantedBy=multi-user.target\n");
  await mkdir(join(root, "etc/standin-tailscale"), { recursive: true });
  await writeFile(join(root, "etc/standin-tailscale/status.json"), status(m.device, devices));
  say("  the install script starts tailscaled:");
  await m.ok("sudo systemctl enable --now tailscaled");
}

/** An image's directory as a build leaves it, with its manifest, and the manifest to record. */
async function placeImage(m: Machine): Promise<string> {
  const script = `
    import { mkdir, writeFile, readFile } from "node:fs/promises";
    import { artifactArchive, sha256Of } from "/opt/nexus/current/src/artifacts.ts";
    const id = "img-f7e5a1c0ffee";
    const dir = "/var/lib/nexus/artifacts/" + id;
    await mkdir(dir, { recursive: true });
    await writeFile(dir + "/rootfs.ext4", "a stand-in, which no pylon boots\\n");
    const pins = JSON.parse(await readFile("/opt/nexus/current/images/pylon/pins.json", "utf8"));
    const manifest = { id, gondolinBuildId: "standin", pins, builtOn: "${box.name}", builtAt: new Date().toISOString(), sha256: await sha256Of(artifactArchive(dir, "image.json")) };
    await writeFile(dir + "/image.json", JSON.stringify(manifest, null, 2) + "\\n");
    console.log(JSON.stringify(manifest));`;
  await writeFile(join(m.device.root, "srv/place-image.mjs"), script);
  const out = await m.ok("node /srv/place-image.mjs && chown -R nexus:nexus /var/lib/nexus/artifacts", { as: "root" });
  return out.trim().split("\n").at(-1)!;
}

main().then(() => process.exit(0), (err: Error) => {
  say(`\nFAIL: ${err.message}`);
  process.exit(1);
});
