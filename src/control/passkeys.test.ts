import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAuthenticator } from "./fake-passkey.ts";
import { codeMs, newCode, passkeyGate, passkeyList, type Purpose } from "./passkeys.ts";
import { openRegistry } from "./registry.ts";

const rp = { id: "rj-firebat.example.ts.net", origin: "https://rj-firebat.example.ts.net:7443" };
const head = "a".repeat(40);
const waive = (h = head): Purpose => ({ kind: "waive", review: "rv-1", repo: "ramtinJ95/nexus", pr: 7, head: h, holds: ["Always needs the person: anything irreversible, as it changes src/control/registry.ts."] });

function fixture(t: import("node:test").TestContext) {
  const registry = openRegistry(":memory:");
  t.after(() => registry.close());
  let clock = 1_000_000;
  const gate = passkeyGate({ registry, rp, now: () => clock });
  const enrol = (authenticator = fakeAuthenticator({ origin: rp.origin }), name = "MacBook Touch ID") => {
    const { code } = newCode(registry, clock);
    return { authenticator, passkey: gate.enrol(authenticator.create(gate.enrolment(code)), name, "nLAPTOP") };
  };
  return { registry, gate, enrol, tick(ms: number) { clock += ms; } };
}

test("a passkey enrols only with a code from the host, which works once and for ten minutes", (t) => {
  const f = fixture(t);
  assert.throws(() => f.gate.enrolment("ABCD-EFGH-JKLM-NPQR-STUV"), { status: 403, message: /not one the control plane's host made/ });

  const { code } = newCode(f.registry, 1_000_000);
  assert.match(code, /^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
  const options = f.gate.enrolment(code.toLowerCase().replaceAll("-", ""));
  assert.equal(options.rp.id, rp.id);
  assert.equal(options.authenticatorSelection.userVerification, "required");
  const authenticator = fakeAuthenticator({ origin: rp.origin });
  const passkey = f.gate.enrol(authenticator.create(options), "MacBook Touch ID", "nLAPTOP");
  assert.equal(passkey.credentialId, authenticator.id);
  assert.deepEqual(passkeyList(f.registry).map((p) => [p.name, p.createdBy, "publicKey" in p]), [["MacBook Touch ID", "nLAPTOP", false]], "the list never sends the public key");
  assert.deepEqual(f.registry.events("0", { kinds: ["passkey.enrolled"] }).map((e) => e.payload.name), ["MacBook Touch ID"]);

  assert.throws(() => f.gate.enrolment(code), { status: 403 }, "a code enrols one passkey");
  const second = newCode(f.registry, 1_000_000);
  f.tick(codeMs - 60_000);
  const late = f.gate.enrolment(second.code);
  f.tick(90_000);
  assert.throws(() => f.gate.enrol(fakeAuthenticator({ origin: rp.origin }).create(late), "Late", "nLAPTOP"), { status: 403, message: /used or expired meanwhile/ });
  assert.equal(f.registry.passkeys().length, 1);
});

test("an enrolment that does not verify the person, or comes from another origin, is refused and keeps its code", (t) => {
  const f = fixture(t);
  const { code } = newCode(f.registry, 1_000_000);
  assert.throws(() => f.gate.enrol(fakeAuthenticator({ origin: rp.origin, verifies: false }).create(f.gate.enrolment(code)), "No PIN", "nLAPTOP"), { status: 403, message: /did not verify the person/ });
  assert.throws(() => f.gate.enrol(fakeAuthenticator({ origin: "http://100.64.0.2:7470" }).create(f.gate.enrolment(code)), "Plain", "nLAPTOP"), { status: 403, message: /not the dashboard's/ });
  assert.throws(() => f.gate.enrol(fakeAuthenticator({ origin: rp.origin, rpId: "evil.example" }).create(f.gate.enrolment(code)), "Evil", "nLAPTOP"), { status: 403, message: /another site/ });
  f.gate.enrol(fakeAuthenticator({ origin: rp.origin }).create(f.gate.enrolment(code)), "Key", "nLAPTOP");
});

test("an assertion confirms only the purpose its challenge was made for, only once, and only within two minutes", (t) => {
  const f = fixture(t);
  const { authenticator, passkey } = f.enrol();
  const atA = authenticator.get(f.gate.challenge(waive()));
  assert.throws(() => f.gate.confirm(atA, waive("b".repeat(40))), { status: 403, message: new RegExp(`confirmed landing commit ${head}, not ${"b".repeat(40)}`) });
  assert.throws(() => f.gate.confirm(atA, waive()), { status: 403, message: /used already or has expired/ }, "a refused assertion is not tried again");

  const ok = authenticator.get(f.gate.challenge(waive()));
  assert.equal(f.gate.confirm(ok, waive()).id, passkey.id);
  assert.throws(() => f.gate.confirm(ok, waive()), { status: 403, message: /used already/ }, "a replay is refused");
  assert.equal(f.registry.passkeys()[0]!.signCount, 3, "the counter the authenticator reported is kept");

  const other = authenticator.get(f.gate.challenge({ ...waive() as Extract<Purpose, { kind: "waive" }>, holds: ["Always needs the person: pylon image rebuilds, as it changes images/pylon/Dockerfile."] }));
  assert.throws(() => f.gate.confirm(other, waive()), { message: /waiving other holds/ });
  const revoke = authenticator.get(f.gate.challenge({ kind: "revoke", passkey: passkey.id }));
  assert.throws(() => f.gate.confirm(revoke, waive()), { message: /confirmed a revocation, not this/ });

  const slow = authenticator.get(f.gate.challenge(waive()));
  f.tick(2 * 60_000);
  assert.throws(() => f.gate.confirm(slow, waive()), { message: /has expired/ });
});

test("an assertion is refused without the person verified, from another origin, from a revoked passkey, or with a counter gone back", (t) => {
  const f = fixture(t);
  const settings = { origin: rp.origin, verifies: true };
  const { authenticator, passkey } = f.enrol(fakeAuthenticator(settings));
  settings.verifies = false;
  assert.throws(() => f.gate.confirm(authenticator.get(f.gate.challenge(waive())), waive()), { status: 403, message: /did not verify the person/ });
  settings.verifies = true;
  settings.origin = "https://preview.example.ts.net:10200";
  assert.throws(() => f.gate.confirm(authenticator.get(f.gate.challenge(waive())), waive()), { status: 403, message: /not the dashboard's/ });
  settings.origin = rp.origin;

  const clone = structuredClone(f.registry.passkeys()[0]!);
  const good = authenticator.get(f.gate.challenge(waive()));
  f.gate.confirm(good, waive());
  f.registry.savePasskeyUse({ ...clone, signCount: 50 });
  assert.throws(() => f.gate.confirm(authenticator.get(f.gate.challenge(waive())), waive()), { message: /counter went from 50/ });

  assert.equal(f.registry.revokePasskey(passkey.id, "test")?.id, passkey.id);
  assert.throws(() => f.gate.challenge(waive()), { status: 409, message: /no passkey is enrolled/ });
  f.enrol(fakeAuthenticator({ origin: rp.origin }), "YubiKey");
  assert.throws(() => f.gate.confirm(authenticator.get(f.gate.challenge(waive())), waive()), { message: /not enrolled, or it was revoked/ });
  assert.deepEqual(f.registry.events("0", { kinds: ["passkey.revoked"] }).map((e) => [e.payload.name, e.payload.by]), [["MacBook Touch ID", "test"]]);
});

test("an authenticator without a counter always reports 0, which is not a clone", (t) => {
  const f = fixture(t);
  const { authenticator } = f.enrol(fakeAuthenticator({ origin: rp.origin, counter: false }));
  for (let i = 0; i < 2; i++) f.gate.confirm(authenticator.get(f.gate.challenge(waive())), waive());
});

test("without the dashboard's HTTPS address, passkeys are off", (t) => {
  const registry = openRegistry(":memory:");
  t.after(() => registry.close());
  const gate = passkeyGate({ registry, rp: null });
  assert.equal(gate.enabled(), false);
  assert.throws(() => gate.enrolment(newCode(registry).code), { status: 409, message: /https.hostname/ });
});

test("the host command runs only as root, so no API caller can make an enrolment code", async (t) => {
  if (process.getuid?.() === 0) return t.skip("runs as root");
  const dir = await mkdtemp(join(tmpdir(), "nexus-passkeys-")); t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, "control.json"), "{}");
  const run = spawnSync(process.execPath, [new URL("./passkeys.ts", import.meta.url).pathname, join(dir, "control.json"), "code"], { encoding: "utf8" });
  assert.equal(run.status, 77);
  assert.match(run.stderr, /run this as root on the control plane's host/);
  assert.equal(spawnSync(process.execPath, [new URL("./passkeys.ts", import.meta.url).pathname, join(dir, "control.json"), "revoke"], { encoding: "utf8" }).status, 64);
});
