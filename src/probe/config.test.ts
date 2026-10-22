import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProbeConfig, parseSecretsEnv, parseSelfDnsName, readSecretsFile } from "./config.ts";

const deploy = new URL("../../deploy/", import.meta.url);

const valid = {
  node: "infra-testbench",
  listen: { host: "100.64.0.7" },
  auth: { controlPlane: "nControl1CNTRL", peers: ["nPeer1CNTRL"] },
  backend: { kind: "pylon-vm", stateRoot: "/var/lib/nexus/pylons", images: { "img-000000000000": "/var/lib/nexus/artifacts/img-000000000000" } },
  secretsFile: "/etc/nexus/secrets.env",
};
const withChange = (change: (config: any) => void) => {
  const config = structuredClone(valid);
  change(config);
  return JSON.stringify(config);
};

test("the shipped example config parses", async () => {
  const config = parseProbeConfig(await readFile(new URL("probe.example.json", deploy), "utf8"));
  assert.equal(config.backend.kind, "pylon-vm");
  assert.equal(config.listen.port, 7480);
  assert.deepEqual(config.previews, { gatewayPort: 7481, routesFile: "/var/lib/nexus/preview-routes.json" });
});

test("previews are optional, and their routes file defaults to the probe's state directory", () => {
  assert.equal(parseProbeConfig(JSON.stringify(valid)).previews, undefined);
  assert.deepEqual(parseProbeConfig(withChange((c) => { c.previews = { gatewayPort: 9000 }; })).previews, { gatewayPort: 9000, routesFile: "/var/lib/nexus/preview-routes.json" });
  assert.throws(() => parseProbeConfig(withChange((c) => { c.previews = { gatewayPort: 9000, routesFile: "routes.json" }; })), /absolute path/);
});

test("a config parses into probe options, with the probe port as the default", () => {
  const config = parseProbeConfig(JSON.stringify(valid));
  assert.deepEqual(config.listen, { host: "100.64.0.7", port: 7480 });
  assert.deepEqual(config.auth, valid.auth);
  assert.deepEqual(config.backend, valid.backend);
});

test("any spelling of a tailnet address is a listen host", () => {
  for (const host of ["100.64.0.7", "100.127.255.254", "fd7a:115c:a1e0::7", "fd7a:115c:a1e0:0:0:0:0:7", "FD7A:115C:A1E0:ab12::1", "::ffff:100.64.0.7"]) {
    assert.equal(parseProbeConfig(withChange((c) => { c.listen.host = host; })).listen.host, host, host);
  }
});

test("the pylon-vm backend takes an optional git SSH key, at absolute paths", () => {
  const gitSsh = { privateKeyFile: "/etc/nexus/git_ed25519", knownHostsFile: "/etc/nexus/known_hosts" };
  const config = parseProbeConfig(withChange((c) => { c.backend.gitSsh = gitSsh; }));
  assert.deepEqual(config.backend, { ...valid.backend, gitSsh });
  assert.throws(() => parseProbeConfig(withChange((c) => { c.backend.gitSsh = { ...gitSsh, privateKeyFile: "git_ed25519" }; })));
});

test("the docker backend takes image tags and optional labels", () => {
  const config = parseProbeConfig(withChange((c) => { c.backend = { kind: "docker", images: { "img-000000000000": "nexus-pylon-test:slice" } }; }));
  assert.deepEqual(config.backend, { kind: "docker", images: { "img-000000000000": "nexus-pylon-test:slice" }, labels: {} });
});

test("a config with a mistake is refused, naming the field", () => {
  const cases: [string, (c: any) => void, RegExp][] = [
    ["an unknown key", (c) => { c.secretFile = c.secretsFile; }, /secretFile/],
    ["an address instead of a stable node ID", (c) => { c.auth.controlPlane = "100.64.0.1"; }, /auth\.controlPlane/],
    ["a peer that is not a stable node ID", (c) => { c.auth.peers = ["rj-firebat"]; }, /auth\.peers\[0\]/],
    ...["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "0::0", "127.0.0.1", "::1", "192.168.1.10", "::ffff:192.168.1.10", "fd7a:115c:a1e1::7"].map((host): [string, (c: any) => void, RegExp] =>
      [`${host} as the listen host`, (c) => { c.listen.host = host; }, /listen\.host/]),
    ["a hostname as the listen host", (c) => { c.listen.host = "infra-testbench"; }, /listen\.host/],
    ["a relative state root", (c) => { c.backend.stateRoot = "pylons"; }, /backend\.stateRoot/],
    ["a relative asset directory", (c) => { c.backend.images = { "img-000000000000": "assets" }; }, /backend\.images/],
    ["a key that is not an image ID", (c) => { c.backend.images = { debian: "/var/lib/nexus/artifacts/debian" }; }, /backend\.images/],
    ["an unknown backend", (c) => { c.backend = { kind: "firecracker" }; }, /backend\.kind/],
    ["a field from the other backend", (c) => { c.backend.labels = {}; }, /labels/],
    ["a missing secrets file", (c) => { delete c.secretsFile; }, /secretsFile/],
  ];
  for (const [what, change, field] of cases) {
    assert.throws(() => parseProbeConfig(withChange(change)), field, what);
  }
  assert.throws(() => parseProbeConfig("{"), SyntaxError, "a config that is not JSON");
});

test("a secrets file maps names to verbatim values", () => {
  const secrets = parseSecretsEnv("# a comment\n\nSTRIPE_KEY=sk_test_a=b#c\r\n  # indented comment\nGH_TOKEN= spaced \n");
  assert.equal(secrets.value("STRIPE_KEY"), "sk_test_a=b#c");
  assert.equal(secrets.value("GH_TOKEN"), " spaced ");
  assert.equal(secrets.value("MISSING"), undefined);
});

test("the shipped example secrets file parses and sets nothing", async () => {
  const secrets = parseSecretsEnv(await readFile(new URL("secrets.example.env", deploy), "utf8"));
  assert.equal(secrets.value("STRIPE_KEY"), undefined);
});

test("a malformed secrets file is refused by line, without echoing values", () => {
  const cases: [string, string, RegExp][] = [
    ["export A=hunter2", "a shell export", /line 1 is not NAME=value/],
    ["A = hunter2", "spaces around =", /line 1 is not NAME=value/],
    ["A=hunter2\nA=hunter3", "a duplicate", /line 2 sets A a second time/],
    ["A=", "an empty value", /line 1 gives A no value/],
    ["\nA=\"hunter2\"", "a quoted value", /line 2 quotes the value of A/],
    ["hunter2", "a bare value", /line 1 is not NAME=value/],
  ];
  for (const [text, what, message] of cases) {
    assert.throws(() => parseSecretsEnv(text), (err: Error) => message.test(err.message) && !err.message.includes("hunter"), what);
  }
});

test("readSecretsFile refuses a file every user can reach and reads one they cannot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-secrets-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "secrets.env");
  await writeFile(path, "STRIPE_KEY=sk_test_1\n");

  for (const mode of [0o644, 0o604, 0o602, 0o601]) {
    await chmod(path, mode);
    await assert.rejects(readSecretsFile(path), new RegExp(`mode ${mode.toString(8)}, so every user`), `mode ${mode.toString(8)}`);
  }
  for (const mode of [0o640, 0o600, 0o400]) {
    await chmod(path, mode);
    assert.equal((await readSecretsFile(path)).value("STRIPE_KEY"), "sk_test_1", `mode ${mode.toString(8)}`);
  }

  await chmod(path, 0o600);
  await writeFile(path, "STRIPE_KEY=\n");
  await assert.rejects(readSecretsFile(path), (err: Error) => err.message.startsWith(`${path}: line 1`), "a parse error names the file");
  await assert.rejects(readSecretsFile(join(dir, "absent.env")), { code: "ENOENT" });
  await mkdir(join(dir, "dir.env"), { mode: 0o700 });
  await assert.rejects(readSecretsFile(join(dir, "dir.env")), /is not a regular file/);
});

test("the node's tailnet name comes from tailscale status without its trailing dot", () => {
  assert.equal(parseSelfDnsName(JSON.stringify({ Version: "1.90.0", Self: { ID: "n1", DNSName: "infra-testbench.example.ts.net." } })), "infra-testbench.example.ts.net");
  assert.throws(() => parseSelfDnsName(JSON.stringify({ Self: { DNSName: "" } })), /no MagicDNS name/);
  assert.throws(() => parseSelfDnsName(JSON.stringify({ BackendState: "Stopped" })), /no Self\.DNSName/);
});
