import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ports } from "../node-base/node-layout.ts";

const root = resolve(import.meta.dirname, "../..");

interface Machine {
  uid: number;
  kernel: string;
  systemd: boolean;
  node: string;
  /** The commands in the units' PATH. */
  commands: string[];
  /** The group of /dev/kvm, or missing. */
  kvm: string;
  arch: string;
  manager: "apt" | "dnf" | "other";
  /** What `tailscale status --json` prints, or null when it fails. */
  status: object | null;
  tailscaled: string[];
  controlConfig: boolean;
  memoryKib: number;
  /** What free_space prints for each path the installer fills, its free KiB and its mount point. */
  free: Record<string, string>;
  /** Whether ss is there to say who listens on a port. */
  ss: boolean;
  /** The unit or command listening on each port that is taken. */
  listeners: Partial<Record<number, string>>;
  /** The home of each user that exists. */
  homes: Record<string, string>;
  /** What /opt/nexus holds. */
  prefixEntries: string[];
  /** The roles installed, which deploy/install.sh finds in /opt/nexus/deployer/roles. */
  roles: string[];
  /** What `systemctl is-active` says of each unit, "unknown" for one it does not list. */
  units: Record<string, string>;
}

const running = {
  BackendState: "Running",
  Self: { ID: "nFirebat1CNTRL", HostName: "firebat", DNSName: "firebat.tail1234.ts.net.", TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"] },
  CurrentTailnet: { Name: "person@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  CertDomains: ["firebat.tail1234.ts.net"],
};

const gib = 1024 * 1024;

const complete: Machine = {
  uid: 0, kernel: "Linux", systemd: true, node: "26", arch: "x86_64", manager: "apt", kvm: "kvm",
  commands: ["qemu-system-x86_64", "qemu-img", "tailscale", "git", "npm"],
  status: running, tailscaled: ["TS_PERMIT_CERT_UID=nexus-control"], controlConfig: false,
  memoryKib: 16 * gib, ss: true, free: { "/var/lib/nexus": `${200 * gib} /`, "/opt/nexus": `${200 * gib} /` }, listeners: {}, homes: {}, prefixEntries: [],
  roles: [], units: {},
};

const fresh: Machine = {
  ...complete,
  uid: 1000, node: "none", kvm: "missing", commands: [], status: null, tailscaled: [],
};

/** Each fact function of deploy/install.sh, answering as `m` does. */
function stubs(m: Machine): string {
  const status = m.status === null ? "return 1" : `cat <<'JSON'\n${JSON.stringify(m.status, null, "\t")}\nJSON`;
  return `
uid() { echo ${m.uid}; }
kernel() { echo ${m.kernel}; }
systemd_booted() { ${m.systemd}; }
node_major() { echo ${m.node}; }
in_service_path() { case " ${m.commands.join(" ")} " in *" $1 "*) return 0 ;; esac; return 1; }
kvm_device() { ${m.kvm !== "missing"}; }
kvm_device_group() { echo ${m.kvm}; }
machine() { echo ${m.arch}; }
package_manager() { echo ${m.manager}; }
tailscale_status() {
${status}
}
tailscaled_environment() { printf '%s\\n' ${m.tailscaled.map((line) => `'${line}'`).join(" ")}; }
control_config_exists() { ${m.controlConfig}; }
memory_kib() { echo ${m.memoryKib}; }
free_space() { case $1 in ${Object.entries(m.free).map(([path, free]) => `'${path}') echo '${free}' ;;`).join(" ")} esac; }
ports_readable() { ${m.ss}; }
port_listener() { case $1 in ${Object.entries(m.listeners).map(([port, unit]) => `${port}) echo '${unit}' ;;`).join(" ")} *) ;; esac; }
user_home() { case $1 in ${Object.entries(m.homes).map(([user, home]) => `${user}) echo '${home}' ;;`).join(" ")} *) ;; esac; }
prefix_entries() { printf '%s\\n' ${m.prefixEntries.map((entry) => `'${entry}'`).join(" ")} | grep . || true; }
installed_roles() { printf '%s\\n' ${m.roles.map((role) => `'${role}'`).join(" ")} | grep . || true; }
unit_state() { case $1 in ${Object.entries(m.units).map(([unit, state]) => `${unit}) echo ${state} ;;`).join(" ")} *) echo unknown ;; esac; }
`;
}

function bash(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile("bash", ["-c", script, "install", root], (err, stdout, stderr) => {
      done({ code: err === null ? 0 : (err.code as number), stdout, stderr });
    });
  });
}

/** The misses check_prerequisites records for the machine, each a sentence and its fix. */
async function misses(m: Machine, role: "control" | "node"): Promise<string[]> {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(m)} check_prerequisites ${role} 'sudo deploy/install.sh'; printf '%s\\0' "\${misses[@]}"`);
  assert.equal(run.code, 0, run.stderr);
  return run.stdout.split("\0").filter((entry) => entry !== "");
}

test("a complete machine misses nothing, for the control plane and for a node", async () => {
  assert.deepEqual(await misses(complete, "control"), [], "a first control install needs no dotfiles repository");
  assert.deepEqual(await misses({ ...complete, controlConfig: true }, "control"), []);
  assert.deepEqual(await misses({ ...complete, tailscaled: [] }, "node"), []);
});

test("a fresh machine reports every miss at once, each with its fix", async () => {
  const found = await misses(fresh, "control");
  assert.deepEqual(found.map((entry) => entry.split("\n")[0]), [
    "- The installer changes the system, so it runs as root.",
    "- Node 26 or newer must be in /usr/local/bin:/usr/bin, found none.",
    "- git must be in /usr/local/bin:/usr/bin. The deployer fetches each release with it.",
    "- Pylons are QEMU VMs, and qemu-system-x86_64 or qemu-img is not in /usr/local/bin:/usr/bin.",
    "- /dev/kvm is missing, so QEMU cannot run pylons with KVM.",
    "- Tailscale is not installed in /usr/local/bin:/usr/bin. Nexus reaches its nodes and callers over the tailnet.",
    "- tailscaled does not let nexus-control fetch the dashboard's certificate. Restarting tailscaled drops tailnet connections for a moment.",
  ]);
  const fixes = found.join("\n");
  for (const fix of [
    "    sudo deploy/install.sh\n",
    "curl -fsSL https://deb.nodesource.com/setup_26.x | sudo bash - && sudo apt-get install -y nodejs",
    "sudo apt-get install -y git",
    "sudo apt-get install -y qemu-system-x86 qemu-utils",
    "sudo modprobe kvm_intel || sudo modprobe kvm_amd",
    "curl -fsSL https://tailscale.com/install.sh | sh",
    "printf '[Service]\\nEnvironment=TS_PERMIT_CERT_UID=nexus-control\\n' | sudo tee /etc/systemd/system/tailscaled.service.d/nexus-cert.conf >/dev/null",
  ]) assert.ok(fixes.includes(fix), fix);
});

test("a node needs no certificate drop-in", async () => {
  const found = await misses(fresh, "node");
  assert.ok(!found.some((entry) => /nexus-control|dotfiles/.test(entry)), found.join("\n"));
});

test("a machine that is not a systemd Linux is told so, and its memory that cannot be read is a miss, not a stop", async () => {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs({ ...complete, kernel: "Darwin" })}
memory_kib() { return 1; }
check_prerequisites node 'sudo deploy/install.sh'; printf '%s\\0' "\${misses[@]}"`);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.stdout.split("\0").filter((entry) => entry !== "").map((entry) => entry.split("\n")[0]), [
    "- Nexus runs as systemd services, and this machine is not a Linux booted with systemd.",
    "- Nexus needs at least 8 GiB of memory, and this machine has 0 MiB.",
  ]);
  for (const m of [{ ...complete, systemd: false }, { ...complete, kernel: "Darwin" }]) {
    assert.match((await misses(m, "node")).join("\n"), /^- Nexus runs as systemd services, and this machine is not a Linux booted with systemd\./);
  }
});

test("Node older than 26 is a miss, and the fix fits the package manager", async () => {
  assert.match((await misses({ ...complete, node: "22", manager: "dnf" }, "node")).join("\n"), /found 22\.\n {4}curl -fsSL https:\/\/rpm\.nodesource\.com\/setup_26\.x/);
  assert.match((await misses({ ...complete, node: "20", manager: "other" }, "node")).join("\n"), /https:\/\/nodejs\.org\/en\/download/);
});

test("pylon images are x86_64, so another architecture is a miss, and either QEMU binary missing is a miss", async () => {
  const arm = { ...complete, arch: "aarch64" };
  assert.deepEqual(await misses(arm, "node"), ["- Pylons run x86_64 images under KVM, and this machine is aarch64.\n    Install on an x86_64 Linux machine."]);
  assert.match((await misses({ ...complete, commands: ["qemu-img", "tailscale"] }, "node")).join("\n"), /qemu-system-x86_64 or qemu-img[^\n]*\n {4}sudo apt-get install -y qemu-system-x86 qemu-utils/);
  assert.match((await misses({ ...complete, manager: "dnf", commands: ["qemu-system-x86_64", "tailscale"] }, "node")).join("\n"), /sudo dnf install -y qemu-system-x86_64-core qemu-img/);
});

test("/dev/kvm outside the kvm group is a miss of its own", async () => {
  assert.deepEqual(await misses({ ...complete, kvm: "root" }, "node"), [
    "- /dev/kvm does not belong to the kvm group, which the probe's user joins to run QEMU.\n    sudo groupadd --system --force kvm && sudo udevadm trigger --name-match=kvm",
  ]);
});

test("a logged-out tailscale is one miss, and the tailnet's settings are checked only once it runs", async () => {
  for (const status of [null, { ...running, BackendState: "NeedsLogin", CurrentTailnet: null, CertDomains: null }]) {
    assert.deepEqual(await misses({ ...complete, status }, "node"), [
      "- Tailscale is not running and logged in.\n    sudo systemctl enable --now tailscaled && sudo tailscale up",
    ]);
  }
});

test("a tailscale status that fails is not running, whatever it printed", async () => {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)}
tailscale_status() { echo '${JSON.stringify(running)}'; return 1; }
check_prerequisites node '' 'sudo deploy/install.sh'; printf '%s\\0' "\${misses[@]}"`);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.stdout.split("\0").filter((entry) => entry !== "").map((entry) => entry.split("\n")[0]), ["- Tailscale is not running and logged in."]);
});

test("MagicDNS and HTTPS certificates turned off are both reported", async () => {
  const status = { ...running, CurrentTailnet: { ...running.CurrentTailnet, MagicDNSEnabled: false }, CertDomains: null };
  assert.deepEqual(await misses({ ...complete, status }, "node"), [
    "- MagicDNS is off. Nodes and preview URLs are named by MagicDNS.\n    Turn on MagicDNS at https://login.tailscale.com/admin/dns",
    "- HTTPS certificates are off. Previews and the dashboard are served over HTTPS.\n    Turn on HTTPS Certificates at https://login.tailscale.com/admin/dns",
  ]);
  assert.equal((await misses({ ...complete, status: { ...running, CertDomains: [] } }, "node")).length, 1);
});

/** A machine some other software got to first, with too little memory and disk, on a tailnet set up wrong, and no Node yet. */
const crowded: Machine = {
  ...complete,
  node: "none", commands: ["qemu-system-x86_64", "qemu-img", "tailscale"],
  memoryKib: 4 * gib, free: { "/var/lib/nexus": `${5 * gib} /`, "/opt/nexus": `${5 * gib} /` },
  listeners: { 7470: "nexus-repository.service" }, homes: { nexus: "/opt/sonatype-work" }, prefixEntries: ["bin", "etc"],
  status: { ...running, CurrentTailnet: { ...running.CurrentTailnet, MagicDNSEnabled: false }, CertDomains: null, Self: { ...running.Self, KeyExpiry: "2027-05-01T00:00:00Z" } },
};

test("a first run without Node lists every miss at once, the tailnet's settings among them", async () => {
  assert.deepEqual((await misses(crowded, "node")).map((entry) => entry.split("\n")[0]), [
    "- Nexus needs at least 8 GiB of memory, and this machine has 4096 MiB.",
    "- Node 26 or newer must be in /usr/local/bin:/usr/bin, found none.",
    "- git must be in /usr/local/bin:/usr/bin. The deployer fetches each release with it.",
    "- Nexus needs at least 20 GiB free on /, which holds /var/lib/nexus, and it has 5 GiB.",
    "- Port 7470 is taken by nexus-repository.service, and Nexus's nexus-control.service listens on it.",
    "- A user nexus exists with home /opt/sonatype-work, so other software made it, and Nexus would run as it.",
    "- /opt/nexus holds files and no releases directory, so other software put them there.",
    "- MagicDNS is off. Nodes and preview URLs are named by MagicDNS.",
    "- HTTPS certificates are off. Previews and the dashboard are served over HTTPS.",
  ]);
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(crowded)}
node() { echo "node $*" >&2; }
main --node firebat`);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /^Warnings:\n- This machine's Tailscale key expires at 2027-05-01T00:00:00Z\. Then it leaves the tailnet, and Nexus loses it until someone logs it in again\.\n {4}Turn off key expiry for this machine at https:\/\/login\.tailscale\.com\/admin\/machines\n/);
  assert.match(run.stderr, /\nThis machine is missing 9 prerequisite\(s\)\. Nothing was changed\./, "the key expiry is a warning, not a miss");
  for (const fix of ["sudo apt-get install -y git", "sudo ss -ltnp 'sport = :7470' names the process", "sudo userdel nexus", "sudo mv /opt/nexus /opt/nexus.other"]) assert.ok(run.stderr.includes(fix), fix);
});

test("a key that expires warns, and the install goes on", async () => {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs({ ...complete, status: { ...running, Self: { ...running.Self, KeyExpiry: "2027-05-01T00:00:00Z" } } })} ${steps}
main --admit macbook`);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /^Warnings:\n- This machine's Tailscale key expires at 2027-05-01T00:00:00Z\./);
  assert.match(run.stderr, /\nnode \.\/src\/deploy\/setup\.ts install --package-manager apt --admit macbook\n$/);
});

test("npm missing is a miss of its own only once Node 26 is there, since the Node fix brings it", async () => {
  assert.deepEqual((await misses({ ...complete, commands: complete.commands.filter((c) => c !== "npm") }, "node")).map((entry) => entry.split("\n")[0]), ["- npm must be in /usr/local/bin:/usr/bin, since each release is built with npm ci. Node 26 came without it."]);
  assert.ok(!(await misses({ ...complete, node: "none", commands: complete.commands.filter((c) => c !== "npm") }, "node")).some((entry) => entry.includes("npm must")));
});

test("memory a little under 8 GiB, as an 8 GiB machine reports, is enough", async () => {
  assert.deepEqual(await misses({ ...complete, memoryKib: 7_900_000 }, "node"), []);
  assert.equal((await misses({ ...complete, memoryKib: 7 * gib }, "node")).length, 1);
});

test("each filesystem short of 20 GiB is one miss, however many of Nexus's paths it holds", async () => {
  assert.equal((await misses({ ...complete, free: { "/var/lib/nexus": `${19 * gib} /`, "/opt/nexus": `${19 * gib} /` } }, "node")).length, 1);
  assert.deepEqual((await misses({ ...complete, free: { "/var/lib/nexus": `${19 * gib} /var`, "/opt/nexus": `${3 * gib} /` } }, "node")).map((entry) => entry.split("\n")[0]), [
    "- Nexus needs at least 20 GiB free on /var, which holds /var/lib/nexus, and it has 19 GiB.",
    "- Nexus needs at least 20 GiB free on /, which holds /opt/nexus, and it has 3 GiB.",
  ]);
});

test("each of Nexus's ports another process holds is a miss, and Nexus's own units on them are not", async () => {
  const taken = Object.fromEntries(Object.values(ports).map((port) => [port, "caddy"]));
  assert.deepEqual((await misses({ ...complete, listeners: taken }, "node")).map((entry) => entry.match(/^- Port (\d+) is taken by caddy/)?.[1]), Object.values(ports).map(String));
  const blind = await bash(`. "$1/deploy/install.sh"; ${stubs({ ...complete, ss: false, listeners: taken })} ${steps}
main --check`);
  assert.equal(blind.code, 0, blind.stderr);
  assert.match(blind.stderr, /^Warnings:\n- ss is missing, so ports 7470, 7443, 7480 and 7481 were not checked\./, "without ss the ports are a warning, not a silent pass");
  const own = { [ports.control]: "nexus-control.service", [ports.dashboard]: "nexus-control.service", [ports.probe]: "nexus-probe.service", [ports.gateway]: "nexus-probe.service" };
  assert.deepEqual(await misses({ ...complete, listeners: own }, "control"), [], "a rerun on an installed machine");
});

test("Nexus's own users and prefix are no miss, so a rerun passes", async () => {
  assert.deepEqual(await misses({ ...complete, homes: { nexus: "/var/lib/nexus", "nexus-control": "/var/lib/nexus-control" }, prefixEntries: ["current", "deployer", "releases"] }, "control"), []);
  assert.match((await misses({ ...complete, homes: { "nexus-control": "/home/nexus-control" } }, "control")).join("\n"), /^- A user nexus-control exists with home \/home\/nexus-control/);
});

test("the installer stops before changing anything when a prerequisite is missing", async () => {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(fresh)}
node() { echo "node $*" >&2; }
bash() { echo "bash $*" >&2; }
main --admit macbook`);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /^This machine is missing 7 prerequisite\(s\)\. Nothing was changed\. Fix each, then rerun:\n- The installer changes the system/);
  assert.match(run.stderr, /\n {4}sudo deploy\/install\.sh --admit macbook\n/);
  assert.doesNotMatch(run.stderr, /^(node|bash) /m);
});

/** Stand-ins for what main runs, each saying on stderr what it ran. */
const steps = `
node() { echo "node \${*//$repo/.}" >&2; }
`;
const ran = (stderr: string) => stderr.trim().split("\n");

test("a complete machine hands every argument to setup.ts install, with the package manager it found", async () => {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} ${steps}
main --admit macbook --dotfiles https://github.com/example/dotfiles.git`);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(ran(run.stderr), ["node ./src/deploy/setup.ts install --package-manager apt --admit macbook --dotfiles https://github.com/example/dotfiles.git"]);
  const node = await bash(`. "$1/deploy/install.sh"; ${stubs({ ...complete, manager: "dnf", tailscaled: [] })} ${steps}
main --node firebat --non-interactive`);
  assert.equal(node.code, 0, node.stderr);
  assert.deepEqual(ran(node.stderr), ["node ./src/deploy/setup.ts install --package-manager dnf --node firebat --non-interactive"], "a node needs no certificate drop-in");
});

test("the prerequisites read the role from the arguments, in either form parseArgs takes", async () => {
  for (const args of ["--dotfiles https://github.com/example/dotfiles.git", "--dotfiles=https://github.com/example/dotfiles.git", "--node=firebat"]) {
    const run = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} ${steps}
main ${args}`);
    assert.equal(run.code, 0, run.stderr);
  }
  const join = await bash(`. "$1/deploy/install.sh"; ${stubs({ ...complete, tailscaled: [] })} ${steps}
main --join tok3n`);
  assert.equal(join.code, 0, join.stderr);
  assert.deepEqual(ran(join.stderr), ["node ./src/deploy/setup.ts install --package-manager apt --join tok3n"], "a join is a node's, so setup.ts says it needs --node");
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} ${steps}
main --admit macbook`);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(ran(run.stderr), ["node ./src/deploy/setup.ts install --package-manager apt --admit macbook"], "a first control install without --dotfiles reaches setup.ts");
});

test("only root on a machine with a control plane mints a join token, from the control plane's release", async (t) => {
  const prefix = await mkdtemp(join(tmpdir(), "nexus-mint-"));
  t.after(() => rm(prefix, { recursive: true, force: true }));
  const mint = (m: Machine, more = "") => bash(`. "$1/deploy/install.sh"; ${stubs(m)} prefix=${prefix}
node() { echo "node \${*//"$prefix"/<prefix>}" >&2; }
main --join-token ${more}`);
  const older = await mint({ ...complete, controlConfig: true });
  assert.notEqual(older.code, 0);
  assert.match(older.stderr, /the control plane here is older than join tokens/);
  await mkdir(join(prefix, "control-current/src/control"), { recursive: true });
  await writeFile(join(prefix, "control-current/src/control/join-token.ts"), "");
  const minted = await mint({ ...complete, controlConfig: true });
  assert.equal(minted.code, 0, minted.stderr);
  assert.equal(minted.stderr.trim(), "node <prefix>/control-current/src/control/join-token.ts /etc/nexus/control.json");
  for (const [m, refusal] of [[{ ...complete, controlConfig: true, uid: 1000 }, /only root on the control plane's machine mints a join token/], [complete, /this machine runs no control plane/]] as const) {
    const refused = await mint(m);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, refusal);
    assert.doesNotMatch(refused.stderr, /^node /m);
  }
  assert.match((await mint({ ...complete, controlConfig: true }, "--node firebat")).stderr, /--join-token takes no other argument/);
});

test("--rotate hands the kind to setup.ts rotate as root, with no prerequisite check, and refuses anyone else", async () => {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(fresh)} uid() { echo 0; } ${steps}
main --rotate github --non-interactive`);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(ran(run.stderr), ["node ./src/deploy/setup.ts rotate github --non-interactive"], "a machine that misses prerequisites still rotates");
  const user = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} uid() { echo 1000; } ${steps}
main --rotate claude`);
  assert.notEqual(user.code, 0);
  assert.match(user.stderr, /only root replaces a stored credential: sudo deploy\/install\.sh --rotate claude/);
  const bare = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} ${steps}
main --rotate`);
  assert.match(bare.stderr, /--rotate names what to replace, claude or github/);
  const late = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} ${steps}
main --non-interactive --rotate github`);
  assert.notEqual(late.code, 0);
  assert.match(late.stderr, /--rotate comes first: sudo deploy\/install\.sh --rotate claude\|github/);
  assert.doesNotMatch(user.stderr + bare.stderr + late.stderr, /^node /m);
});

test("--check on a fresh machine lists the misses and runs nothing", async () => {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(fresh)} ${steps}
installed_check() { echo "installed_check" >&2; }
main --check`);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /^This machine has 7 problem\(s\)\. --check changed nothing\. Fix each, then check again:\n- The installer changes the system/);
  assert.match(run.stderr, /\n {4}sudo deploy\/install\.sh --check\n/);
  assert.doesNotMatch(run.stderr, /^(node|installed_check)/m);
  const ready = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} ${steps}
main --check`);
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(ready.stdout, "Every prerequisite holds. Nexus is not installed here yet. --check changed nothing.\n");
  assert.equal(ready.stderr, "");
});

const installed: Machine = {
  ...complete,
  roles: ["control", "probe"],
  homes: { nexus: "/var/lib/nexus", "nexus-control": "/var/lib/nexus-control" }, prefixEntries: ["control-current", "current", "deployer", "releases"],
  listeners: { [ports.control]: "nexus-control.service", [ports.dashboard]: "nexus-control.service", [ports.probe]: "nexus-probe.service", [ports.gateway]: "nexus-probe.service" },
  units: Object.fromEntries(["nexus-control.service", "nexus-probe.service", "nexus-backup.timer", "nexus-deployer.timer", "nexus-deployer.path"].map((unit) => [unit, "active"])),
};

test("--check on an installed machine adds its units and what installed.ts finds, and changes nothing", async () => {
  const healthy = await bash(`. "$1/deploy/install.sh"; ${stubs(installed)} ${steps}
installed_check() { echo "installed_check \${*//$repo/.}" >&2; }
main --check`);
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.equal(healthy.stdout, "Every prerequisite holds, and the installed control probe role(s) run as they should. --check changed nothing.\n");
  const units = { ...installed.units, "nexus-control.service": "inactive", "nexus-backup.service": "failed", "nexus-deployer.service": "inactive" };
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs({ ...installed, units })} ${steps}
installed_check() { printf -- '- /opt/nexus/current runs %s, and the desired release is %s.\\n    nexus release says where the deploy stands\\0' "$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..40})"; printf -- '- /etc/nexus/probe.json: invalid.\\n    Correct it\\0'; }
main --check`);
  assert.equal(run.code, 1);
  assert.deepEqual(run.stderr.split("\n").filter((line) => line.startsWith("- ")), [
    "- nexus-control.service is inactive, and should be running.",
    "- nexus-backup.service failed its last run.",
    `- /opt/nexus/current runs ${"a".repeat(40)}, and the desired release is ${"b".repeat(40)}.`,
    "- /etc/nexus/probe.json: invalid.",
  ]);
  assert.match(run.stderr, /^This machine has 4 problem\(s\)\. --check changed nothing\./);
  assert.match(run.stderr, /\n {4}sudo systemctl start nexus-control\.service, and journalctl -u nexus-control\.service -n 50 says why it stopped\n/);
  assert.doesNotMatch(run.stderr, /^node /m, "--check never reaches setup.ts install");
});

test("--check on an installed node checks the node's units and needs no certificate drop-in", async () => {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs({ ...installed, roles: ["probe"], tailscaled: [], units: { "nexus-probe.service": "active", "nexus-deployer.timer": "active", "nexus-deployer.path": "active", "nexus-backup.service": "failed" } })} ${steps}
installed_check() { :; }
main --check`);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /the installed probe role\(s\) run as they should/);
});

test("--check runs src/deploy/installed.ts on the prefix and config directory, and says how to see why when it fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "opt/deployer/roles"), { recursive: true });
  await writeFile(join(dir, "opt/deployer/roles/probe"), "");
  await mkdir(join(dir, "etc"));
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs({ ...installed, roles: ["probe"], free: { ...installed.free, [`${dir}/opt`]: `${200 * gib} /` } })} prefix=${dir}/opt etc=${dir}/etc
main --check --node firebat`);
  assert.equal(run.code, 1);
  assert.deepEqual(run.stderr.split("\n").filter((line) => line.startsWith("- ")), [
    `- ${dir}/opt/current is missing, so the probe has no release.`,
    `- ${dir}/etc/control-plane.json is missing. deploy/install.sh writes it, and so does deploy/set-control-plane.sh.`,
    `- ${dir}/etc/deployer.json is missing. deploy/install.sh writes it.`,
  ]);
  const broken = await bash(`. "$1/deploy/install.sh"; ${stubs({ ...installed, node: "none", units: { ...installed.units, "nexus-probe.service": "failed" } })}
installed_check() { echo "node: command not found" >&2; return 127; }
main --check`);
  assert.equal(broken.code, 1);
  assert.deepEqual(broken.stderr.split("\n").filter((line) => line.startsWith("- ")), [
    "- Node 26 or newer must be in /usr/local/bin:/usr/bin, found none.",
    "- nexus-probe.service is failed, and should be running.",
    "- src/deploy/installed.ts could not check the install's links and configs.",
  ], "the misses found before it stay");
  assert.match(broken.stderr, /\n {4}See what it says: sudo node .*\/src\/deploy\/installed\.ts \/opt\/nexus \/etc\/nexus\n$/);
});
