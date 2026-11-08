import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { controlFields, listenAddress, probeFields } from "./node-config.ts";
import { parseConfig } from "../control/main.ts";
import { parseProbeConfig } from "../probe/config.ts";

const example = (name: string) => JSON.parse(readFileSync(new URL(`../../deploy/${name}.example.json`, import.meta.url), "utf8")) as Record<string, unknown>;

test("the readers take from a config what its schema parses, so deploy and the services agree on each field", () => {
  const control = { ...example("control"), github: { tokenFile: "/etc/nexus/github-token" } };
  const parsed = parseConfig(JSON.stringify(control));
  assert.deepEqual(controlFields(control, "control.json"), { db: parsed.db, callers: parsed.callers, harnessCredentials: parsed.harness.credentials, githubTokenFile: parsed.github?.tokenFile });
  assert.deepEqual(listenAddress(control, "control.json"), { host: parsed.listen.host, port: parsed.listen.port });

  const base = example("probe");
  const probe = { ...base, backend: { ...base["backend"] as object, gitSsh: { privateKeyFile: "/etc/nexus/git_ed25519", knownHostsFile: "/etc/nexus/git_known_hosts" } } };
  const parsedProbe = parseProbeConfig(JSON.stringify(probe));
  assert.deepEqual(probeFields(probe, "probe.json"), { node: parsedProbe.node, secretsFile: parsedProbe.secretsFile, gitKeyFile: parsedProbe.backend.kind === "pylon-vm" ? parsedProbe.backend.gitSsh?.privateKeyFile : undefined });
  assert.deepEqual(listenAddress(probe, "probe.json"), { host: parsedProbe.listen.host, port: parsedProbe.listen.port });
});

test("a missing file or field reads as undefined, and a field of another kind throws naming the file and the field", () => {
  for (const missing of [null, undefined, {}, { harness: 5, github: null }]) {
    assert.deepEqual(controlFields(missing, "control.json"), { db: undefined, callers: undefined, harnessCredentials: undefined, githubTokenFile: undefined });
  }
  assert.deepEqual(probeFields({ backend: {} }, "probe.json"), { node: undefined, secretsFile: undefined, gitKeyFile: undefined });
  assert.deepEqual(controlFields({ harness: { credentials: null }, callers: null }, "control.json").harnessCredentials, undefined, "a null field takes the default, as `??` gave it");
  assert.deepEqual(probeFields({ secretsFile: null, backend: { gitSsh: { privateKeyFile: null } } }, "probe.json"), { node: undefined, secretsFile: undefined, gitKeyFile: undefined });
  assert.throws(() => controlFields({ callers: ["nA", 7] }, "/etc/nexus/control.json"), /^Error: \/etc\/nexus\/control\.json's callers is not a list of strings$/);
  assert.throws(() => probeFields({ backend: { gitSsh: { privateKeyFile: 1 } } }, "probe.json"), /^Error: probe\.json's backend\.gitSsh\.privateKeyFile is not a string$/);
  assert.throws(() => listenAddress({ listen: { host: "::1", port: "7480" } }, "probe.json"), /probe\.json's listen\.port is not a number/);
  assert.throws(() => listenAddress(null, "probe.json"), /^Error: probe\.json has no listen\.host$/);
});
