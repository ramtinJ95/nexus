import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as layout from "./node-layout.ts";
import { backupStatusFile, configFiles, controlPath, deployerFiles, deployerLink, deployerWakeFile, etc, ports, prefix, releasesDir, roleLinks, servicePath, stateDirs, unitNames, users } from "./node-layout.ts";
import { defaultPreviewPorts, parseConfig } from "./control/main.ts";
import { probePort } from "./protocol/routes.ts";
import { stores } from "./deploy/credentials.ts";
import { backupBudgetMs, drainYieldMs } from "./deploy/worker.ts";
import { shutdownPauseMs } from "./probe/shutdown.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const seconds = (text: string, key: string) => {
  const [, value, unit] = new RegExp(`^${key}=(\\d+)(min|s)?$`, "m").exec(text) ?? assert.fail(`${key} is set`);
  return Number(value) * (unit === "min" ? 60 : 1);
};

test("each layout constant is the literal it replaced", () => {
  const values = Object.fromEntries(Object.entries(layout).filter(([, value]) => typeof value !== "function"));
  assert.deepEqual(values, {
    prefix: "/opt/nexus",
    etc: "/etc/nexus",
    unitDir: "/etc/systemd/system",
    users: { probe: "nexus", control: "nexus-control" },
    stateDirs: { probe: "/var/lib/nexus", control: "/var/lib/nexus-control", backup: "/var/lib/nexus-backup" },
    configFiles: {
      control: "/etc/nexus/control.json",
      controlPlane: "/etc/nexus/control-plane.json",
      probe: "/etc/nexus/probe.json",
      deployer: "/etc/nexus/deployer.json",
      secrets: "/etc/nexus/secrets.env",
      githubToken: "/etc/nexus/github-token",
      gitKey: "/etc/nexus/git_ed25519",
      gitKnownHosts: "/etc/nexus/git_known_hosts",
    },
    servicePath: "/usr/local/bin:/usr/bin",
    rootPath: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    unitNames: {
      probe: "nexus-probe.service",
      control: "nexus-control.service",
      backup: "nexus-backup.service",
      backupTimer: "nexus-backup.timer",
      deployer: "nexus-deployer.service",
      deployerTimer: "nexus-deployer.timer",
      deployerPath: "nexus-deployer.path",
    },
    ports: { control: 7470, dashboard: 7443, probe: 7480, gateway: 7481 },
    links: { current: "the probe", "control-current": "the control plane", "deployer-current": "the deployer's worker" },
    roleLinks: { probe: "current", control: "control-current" },
    deployerLink: "deployer-current",
    releasesDir: "releases",
    deployerFiles: { lock: "deployer/lock", roles: "deployer/roles", repo: "deployer/repo", rejected: "deployer/rejected", releaseBytes: "deployer/release-bytes.json" },
    deployerWakeFile: "/var/lib/nexus/deployer-wake",
    backupStatusFile: "/var/lib/nexus-backup/status.json",
    releaseName: /^(?:[0-9a-f]{12}|[0-9a-f]{40})$/,
  });
  assert.equal(layout.deployJournal("control"), "control-deploy.json");
  assert.equal(controlPath("registry.db"), "/var/lib/nexus-control/registry.db");
  assert.equal(controlPath("/srv/registry.db"), "/srv/registry.db");
  assert.equal(layout.releaseCommitFile("/opt/nexus/releases/x"), "/opt/nexus/releases/x/release-commit");
  assert.deepEqual(stores, {
    harness: { machines: "control", file: "/var/lib/nexus-control/harness-credentials.json", owner: "nexus-control:nexus-control", mode: 0o600 },
    claude: { machines: "every", file: "/etc/nexus/secrets.env", owner: "root:nexus", mode: 0o640 },
    githubWatch: { machines: "control", file: "/etc/nexus/github-token", owner: "root:nexus-control", mode: 0o640 },
    gitKey: { machines: "every", file: "/etc/nexus/git_ed25519", owner: "nexus:nexus", mode: 0o400 },
  });
});

test("release.sh and the role installers name the layout's prefix, releases, release names, state, users, links and lock", () => {
  const release = read("deploy/release.sh");
  for (const line of [
    `prefix=${prefix}`, `etc=${etc}`, `service_path=${servicePath}`,
    `make_state ${users.control} ${stateDirs.control}`, `make_state ${users.probe} ${stateDirs.probe} pylons artifacts`,
    `exec 9>"$prefix/${deployerFiles.lock}"`, `flock -x "$prefix/${deployerFiles.lock}" "$@"`,
    `install -d -o root -g root -m 0755 "$prefix" "$prefix/${releasesDir}"`, `mv "$staging" "$prefix/${releasesDir}/$release"`,
    "| sha256sum | cut -c1-12)", '[[ "$NEXUS_COMMIT" =~ ^[0-9a-f]{40}$ ]]',
    `install -o root -g ${stores.claude.owner.split(":")[1]} -m 0${stores.claude.mode.toString(8)} "$1/deploy/secrets.example.env" "$etc/secrets.env"`,
  ]) assert.ok(release.includes(line), line);
  assert.ok(stores.claude.file === `${etc}/secrets.env` && stores.claude.owner.startsWith("root:"));
  assert.ok(layout.releaseName.test("a".repeat(12)) && layout.releaseName.test("a".repeat(40)) && !layout.releaseName.test("a".repeat(13)), "release.sh's two name shapes");
  assert.match(read("deploy/install-probe.sh"), new RegExp(`^link_release "\\$prefix/${roleLinks.probe}"$`, "m"));
  assert.match(read("deploy/install-control.sh"), new RegExp(`^link_release "\\$prefix/${roleLinks.control}"$`, "m"));
  const installDeployer = read("deploy/install-deployer.sh");
  assert.ok(installDeployer.includes(`touch "$prefix/${deployerFiles.roles}/$role"`));
  assert.ok(installDeployer.includes(`[ -e ${configFiles.deployer} ]`));
});

test("supervise-deployer.sh, which runs alone, names the layout's prefix, lock, link and rejected file", () => {
  const supervise = read("deploy/supervise-deployer.sh");
  for (const line of [
    `prefix=${prefix}`, `exec 9>"$prefix/${deployerFiles.lock}"`, `worker="$prefix/${deployerLink}/src/deploy/worker.ts"`,
    `readlink "$prefix/${deployerLink}" > "$prefix/${deployerFiles.rejected}"`, `rm -f "$prefix/${deployerLink}"`,
  ]) assert.ok(supervise.includes(line), line);
});

test("the units run the layout's users, state, PATH, links and configs, and the deployer.path watches its wake file", () => {
  const probe = read(`deploy/${unitNames.probe}`);
  for (const line of [`User=${users.probe}`, `WorkingDirectory=${stateDirs.probe}`, `Environment=PATH=${servicePath}`, `ExecStart=/usr/bin/env node ${prefix}/${roleLinks.probe}/src/probe/main.ts ${configFiles.probe}`]) {
    assert.match(probe, new RegExp(`^${RegExp.escape(line)}$`, "m"), line);
  }
  const control = read(`deploy/${unitNames.control}`);
  for (const line of [`User=${users.control}`, `WorkingDirectory=${stateDirs.control}`, `ReadWritePaths=${stateDirs.control}`, `Environment=PATH=${servicePath}`, `ExecStart=/usr/bin/env node ${prefix}/${roleLinks.control}/src/control/main.ts ${configFiles.control}`]) {
    assert.match(control, new RegExp(`^${RegExp.escape(line)}$`, "m"), line);
  }
  assert.match(read(`deploy/${unitNames.backup}`), new RegExp(`^ExecStart=/usr/bin/env node ${RegExp.escape(`${prefix}/${roleLinks.control}/src/control/backup.ts`)} backup ${RegExp.escape(configFiles.control)}$`, "m"));
  assert.match(read("deploy/nexus-deployer.path"), new RegExp(`^PathChanged=${RegExp.escape(deployerWakeFile)}$`, "m"));
  assert.ok(backupStatusFile.startsWith(`${stateDirs.backup}/`));
});

test("the deployer's and the probe's own deadlines fit inside the timeouts their scripts and units give them", () => {
  const supervise = read("deploy/supervise-deployer.sh");
  const [, kill, worker] = (/timeout --kill-after=(\d+)s (\d+)s/.exec(supervise) ?? assert.fail("the supervisor bounds the worker")).map(Number) as [number, number, number];
  assert.equal(worker, 900);
  assert.ok(backupBudgetMs < worker * 1000 && drainYieldMs < worker * 1000, "a backup or a drain wait yields before the supervisor's timeout");
  assert.ok(2 * (worker + kill) <= seconds(read("deploy/nexus-deployer.service"), "TimeoutStartSec"), "the unit outlasts a failed worker and the bootstrap after it");
  assert.ok(shutdownPauseMs / 1000 + 30 <= seconds(read(`deploy/${unitNames.probe}`), "TimeoutStopSec"), "the probe's stop timeout leaves 30 s for the close after the pauses");
});

test("unitNames names every unit file in deploy/", () => {
  const files = readdirSync(new URL("../deploy/", import.meta.url)).filter((name) => /\.(service|timer|path)$/.test(name));
  assert.deepEqual([...Object.values(unitNames)].sort(), files.sort());
});

test("the example configs and the probe protocol use the layout's ports, and the default preview ports stay clear of them", () => {
  const control = JSON.parse(read("deploy/control.example.json")) as { listen: { port: number } };
  const probe = JSON.parse(read("deploy/probe.example.json")) as { listen: { port: number }; previews: { gatewayPort: number } };
  assert.equal(control.listen.port, ports.control);
  assert.equal(ports.probe, probePort, "src/protocol may not import the layout, so routes.ts keeps its own copy");
  assert.equal(probe.listen.port, ports.probe);
  assert.equal(probe.previews.gatewayPort, ports.gateway);
  for (const port of Object.values(ports)) assert.ok(port < defaultPreviewPorts.first || port > defaultPreviewPorts.last, `${port} is outside the preview range`);
});

test("control.json's db is opened from the control plane's working directory", () => {
  const example = JSON.parse(read("deploy/control.example.json")) as Record<string, unknown>;
  assert.equal(parseConfig(JSON.stringify({ ...example, db: "registry.db" })).db, `${stateDirs.control}/registry.db`);
  assert.equal(parseConfig(JSON.stringify(example)).db, "/var/lib/nexus-control/registry.db");
  assert.equal(parseConfig(JSON.stringify({ ...example, db: "/srv/nexus/registry.db" })).db, "/srv/nexus/registry.db");
});
