import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

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
}

const running = {
  BackendState: "Running",
  Self: { ID: "nFirebat1CNTRL", HostName: "firebat", DNSName: "firebat.tail1234.ts.net.", TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"] },
  CurrentTailnet: { Name: "person@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  CertDomains: ["firebat.tail1234.ts.net"],
};

const complete: Machine = {
  uid: 0, kernel: "Linux", systemd: true, node: "26", arch: "x86_64", manager: "apt", kvm: "kvm",
  commands: ["qemu-system-x86_64", "qemu-img", "tailscale"],
  status: running, tailscaled: ["TS_PERMIT_CERT_UID=nexus-control"], controlConfig: false,
};

const fresh: Machine = {
  uid: 1000, kernel: "Linux", systemd: true, node: "none", arch: "x86_64", manager: "apt", kvm: "missing",
  commands: [], status: null, tailscaled: [], controlConfig: false,
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
async function misses(m: Machine, role: "control" | "node", dotfiles = ""): Promise<string[]> {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(m)} check_prerequisites ${role} '${dotfiles}' 'sudo deploy/install.sh'; printf '%s\\0' "\${misses[@]}"`);
  assert.equal(run.code, 0, run.stderr);
  return run.stdout.split("\0").filter((entry) => entry !== "");
}

test("a complete machine misses nothing, for the control plane and for a node", async () => {
  assert.deepEqual(await misses(complete, "control", "https://github.com/example/dotfiles.git"), []);
  assert.deepEqual(await misses({ ...complete, controlConfig: true }, "control"), []);
  assert.deepEqual(await misses({ ...complete, tailscaled: [] }, "node"), []);
});

test("a fresh machine reports every miss at once, each with its fix", async () => {
  const found = await misses(fresh, "control");
  assert.deepEqual(found.map((entry) => entry.split("\n")[0]), [
    "- The installer changes the system, so it runs as root.",
    "- Node 26 or newer must be in /usr/local/bin:/usr/bin, found none.",
    "- Pylons are QEMU VMs, and qemu-system-x86_64 or qemu-img is not in /usr/local/bin:/usr/bin.",
    "- /dev/kvm is missing, so QEMU cannot run pylons with KVM.",
    "- Tailscale is not installed in /usr/local/bin:/usr/bin. Nexus reaches its nodes and callers over the tailnet.",
    "- tailscaled does not let nexus-control fetch the dashboard's certificate. Restarting tailscaled drops tailnet connections for a moment.",
    "- A first control plane install needs the dotfiles repository every pylon pulls on boot.",
  ]);
  const fixes = found.join("\n");
  for (const fix of [
    "    sudo deploy/install.sh\n",
    "curl -fsSL https://deb.nodesource.com/setup_26.x | sudo bash - && sudo apt-get install -y nodejs",
    "sudo apt-get install -y qemu-system-x86 qemu-utils",
    "sudo modprobe kvm_intel || sudo modprobe kvm_amd",
    "curl -fsSL https://tailscale.com/install.sh | sh",
    "printf '[Service]\\nEnvironment=TS_PERMIT_CERT_UID=nexus-control\\n' | sudo tee /etc/systemd/system/tailscaled.service.d/nexus-cert.conf >/dev/null",
    "sudo deploy/install.sh --dotfiles https://github.com/<you>/dotfiles.git",
  ]) assert.ok(fixes.includes(fix), fix);
});

test("a node needs neither the certificate drop-in nor dotfiles", async () => {
  const found = await misses(fresh, "node");
  assert.ok(!found.some((entry) => /nexus-control|dotfiles/.test(entry)), found.join("\n"));
});

test("a machine that is not a systemd Linux is told so", async () => {
  for (const m of [{ ...complete, systemd: false }, { ...complete, kernel: "Darwin" }]) {
    assert.match((await misses(m, "node")).join("\n"), /^- Nexus runs as systemd services, and this machine is not a Linux booted with systemd\./);
  }
});

test("Node older than 26 is a miss, and the fix fits the package manager", async () => {
  assert.match((await misses({ ...complete, node: "22", manager: "dnf" }, "node")).join("\n"), /found 22\.\n {4}curl -fsSL https:\/\/rpm\.nodesource\.com\/setup_26\.x/);
  assert.match((await misses({ ...complete, node: "20", manager: "other" }, "node")).join("\n"), /https:\/\/nodejs\.org\/en\/download/);
});

test("QEMU is looked for under the machine's architecture, and either binary missing is a miss", async () => {
  const arm = { ...complete, arch: "aarch64", commands: ["qemu-system-x86_64", "qemu-img", "tailscale"] };
  assert.match((await misses(arm, "node")).join("\n"), /qemu-system-aarch64 or qemu-img[^\n]*\n {4}sudo apt-get install -y qemu-system-arm qemu-utils/);
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

test("MagicDNS and HTTPS certificates turned off are both reported", async () => {
  const status = { ...running, CurrentTailnet: { ...running.CurrentTailnet, MagicDNSEnabled: false }, CertDomains: null };
  assert.deepEqual(await misses({ ...complete, status }, "node"), [
    "- MagicDNS is off. Nodes and preview URLs are named by MagicDNS.\n    Turn on MagicDNS at https://login.tailscale.com/admin/dns",
    "- HTTPS certificates are off. Previews and the dashboard are served over HTTPS.\n    Turn on HTTPS Certificates at https://login.tailscale.com/admin/dns",
  ]);
  assert.equal((await misses({ ...complete, status: { ...running, CertDomains: [] } }, "node")).length, 1);
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

/** Stand-ins for what main runs, each saying on stderr what it ran. `setup.ts credentials` prints `next`, the installer's next steps. */
function steps(next: readonly string[] = []): string {
  return `
node() { echo "node \${*//$repo/.}" >&2; [ "$2" != credentials ] || printf '%s\\n' ${next.join(" ")}; }
bash() { echo "bash \${*//$repo/.}" >&2; }
systemctl() { echo "systemctl $*" >&2; }
install() { :; }
flock() { echo "flock $1 \${2//$prefix/<prefix>}" >&2; shift 2; "$@"; }
`;
}
const ran = (stderr: string) => stderr.trim().split("\n");

test("a complete machine writes the configs, runs each role's installer, gives the agents their credentials, then says what is left", async () => {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} ${steps()}
main --admit macbook --dotfiles https://github.com/example/dotfiles.git`);
  assert.equal(run.code, 0, run.stderr);
  const args = "--admit macbook --dotfiles https://github.com/example/dotfiles.git";
  assert.deepEqual(ran(run.stderr), [
    "flock -x <prefix>/deployer/lock",
    `node ./src/deploy/setup.ts write ${args}`,
    "bash ./deploy/install-control.sh",
    "bash ./deploy/install-probe.sh",
    "bash ./deploy/install-deployer.sh control probe",
    `node ./src/deploy/setup.ts credentials ${args}`,
    `node ./src/deploy/setup.ts left ${args}`,
  ]);
  const node = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} ${steps()}
main --node firebat --non-interactive`);
  assert.equal(node.code, 0, node.stderr);
  assert.deepEqual(ran(node.stderr), [
    "flock -x <prefix>/deployer/lock",
    "node ./src/deploy/setup.ts write --node firebat --non-interactive",
    "bash ./deploy/install-probe.sh",
    "bash ./deploy/install-deployer.sh probe",
    "node ./src/deploy/setup.ts credentials --node firebat --non-interactive",
    "node ./src/deploy/setup.ts left --node firebat --non-interactive",
  ]);
});

test("after the credentials, a new git key rewrites the configs and reinstalls the probe, a new secret restarts the probe if it runs, and a signed-in harness installs the control plane again", async () => {
  const after = async (next: readonly string[]) => {
    const run = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} ${steps(next)}
main --dotfiles https://github.com/example/dotfiles.git`);
    assert.equal(run.code, 0, run.stderr);
    const lines = ran(run.stderr);
    return lines.slice(lines.findIndex((line) => line.includes("setup.ts credentials")) + 1, -1);
  };
  const args = "--dotfiles https://github.com/example/dotfiles.git";
  assert.deepEqual(await after(["config", "probe", "control"]), [
    "flock -x <prefix>/deployer/lock", `node ./src/deploy/setup.ts write ${args}`, "bash ./deploy/install-probe.sh", "bash ./deploy/install-control.sh",
  ]);
  assert.deepEqual(await after(["probe"]), ["systemctl try-restart nexus-probe.service"]);
  assert.deepEqual(await after([]), [], "a run that changed no credential restarts nothing");
});

test("a failed credentials step stops the installer before it says what is left", async () => {
  const run = await bash(`. "$1/deploy/install.sh"; ${stubs(complete)} ${steps()}
node() { echo "node \${*//$repo/.}" >&2; [ "$2" != credentials ] || return 1; }
main --node firebat`);
  assert.notEqual(run.code, 0);
  assert.doesNotMatch(run.stderr, /setup\.ts left/);
});
