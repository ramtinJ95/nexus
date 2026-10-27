/**
 * Passkeys: how the control plane tells the person from an agent. Every caller is a tailnet node, and an agent on the
 * person's Mac is the same node as the person, so the API alone cannot tell them apart. A passkey can: its
 * authenticator verifies the person, with a PIN or biometrics, before it signs, and an agent cannot press it.
 *
 * An agent could still enrol an authenticator of its own, such as a software one, so enrolling takes a code that only
 * root on the control plane's host can make, with this file's host command. Each code works once, within 10 minutes.
 * The registry keeps each passkey's public key and metadata, never a secret.
 *
 * Every assertion answers a challenge made for one purpose: landing one review at one commit with named holds
 * waived, or revoking one passkey. The challenge is a hash of a random nonce and that purpose, held in memory for two
 * minutes and taken on first use, so an assertion counts once and only for what the person confirmed.
 *
 *   sudo node src/control/passkeys.ts <config.json> code | list | revoke <id>
 */
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { HttpError } from "./http-error.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { algorithms, verifyAssertion, verifyRegistration, WebAuthnError, type Assertion, type RelyingParty } from "./webauthn.ts";

export interface Passkey {
  id: string;
  name: string;
  /** The WebAuthn credential ID, base64url, and its public key, SPKI DER in base64. */
  credentialId: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
  createdAt: number;
  /** The tailnet node the person enrolled it from. */
  createdBy: string;
  lastUsedAt: number | null;
}

/** What an assertion confirms. Its challenge commits to it, so the assertion confirms nothing else. */
export type Purpose =
  | { kind: "waive"; review: string; repo: string; pr: number; head: string; holds: string[] }
  | { kind: "revoke"; passkey: string };
type Pending = { purpose: Purpose | { kind: "enrol"; code: string }; nonce: string; expires: number };

export const codeMs = 10 * 60_000;
const challengeMs = 2 * 60_000;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** A code as the person may type it: any case, with or without its dashes. */
const normalCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
const challengeOf = (pending: Omit<Pending, "expires">) => createHash("sha256").update(pending.nonce).update(JSON.stringify(pending.purpose)).digest("base64url");

/** A fresh enrolment code, 100 random bits in five groups of four. Only its hash is stored. */
export function newCode(registry: Registry, now = Date.now()): { code: string; expiresAt: number } {
  const chars = [...randomBytes(20)].map((b) => codeAlphabet[b % codeAlphabet.length]!).join("");
  const code = chars.match(/.{4}/g)!.join("-");
  registry.addPasskeyCode(hash(normalCode(code)), now + codeMs);
  return { code, expiresAt: now + codeMs };
}

export const passkeyList = (registry: Registry) => registry.passkeys().map(({ publicKey: _, ...p }) => p);

/** Each purpose's refusal when an assertion confirmed something else, said as the person would read it. */
function mismatch(confirmed: Pending["purpose"], wanted: Purpose): string {
  if (confirmed.kind !== wanted.kind) return `the passkey confirmed ${confirmed.kind === "waive" ? "a landing" : confirmed.kind === "revoke" ? "a revocation" : "an enrolment"}, not this`;
  if (confirmed.kind === "revoke") return `the passkey confirmed revoking ${confirmed.passkey}, not ${(wanted as typeof confirmed).passkey}`;
  const want = wanted as Extract<Purpose, { kind: "waive" }>;
  if (confirmed.kind === "waive" && confirmed.review === want.review && confirmed.head !== want.head) return `the passkey confirmed landing commit ${confirmed.head}, not ${want.head}`;
  if (confirmed.kind === "waive" && confirmed.review === want.review) return "the passkey confirmed waiving other holds than these";
  return "the passkey confirmed landing another review";
}

export function passkeyGate(deps: { registry: Registry; rp: RelyingParty | null; now?: () => number }) {
  const { registry } = deps;
  const now = deps.now ?? Date.now;
  const pending = new Map<string, Pending>();

  const relyingParty = (): RelyingParty => deps.rp ?? (() => { throw new HttpError(409, "passkeys need the dashboard's HTTPS address, and the control plane's config has no https.hostname"); })();
  function issue(purpose: Pending["purpose"]): string {
    for (const [challenge, p] of pending) if (p.expires <= now()) pending.delete(challenge);
    const p = { purpose, nonce: randomBytes(32).toString("base64url"), expires: now() + challengeMs };
    const challenge = challengeOf(p);
    pending.set(challenge, p);
    return challenge;
  }
  /** Takes the challenge, so whatever happens next it answers nothing again. */
  function take(challenge: string): Pending {
    const p = pending.get(challenge);
    pending.delete(challenge);
    if (p === undefined || p.expires <= now() || challengeOf(p) !== challenge) throw new HttpError(403, "the passkey's confirmation was used already or has expired, so it confirms nothing. Confirm again");
    return p;
  }
  const refused = (err: unknown): never => { throw err instanceof WebAuthnError ? new HttpError(403, err.message) : err; };

  return {
    enabled: () => deps.rp !== null,

    /** The options for `navigator.credentials.create`, for a code that can still enrol. */
    enrolment(code: string) {
      const rp = relyingParty();
      const codeHash = hash(normalCode(code));
      if (!registry.passkeyCodeOpen(codeHash, now())) throw new HttpError(403, "that enrolment code is not one the control plane's host made, or it was used or has expired. Make one on the host with `sudo node /opt/nexus/control-current/src/control/passkeys.ts /etc/nexus/control.json code`");
      return {
        challenge: issue({ kind: "enrol", code: codeHash }), rp: { id: rp.id, name: "Nexus" }, timeout: challengeMs,
        user: { id: Buffer.from("nexus-person").toString("base64url"), name: "person", displayName: "The person" },
        pubKeyCredParams: algorithms.map((alg) => ({ type: "public-key", alg })),
        excludeCredentials: registry.passkeys().map((p) => ({ type: "public-key", id: p.credentialId })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, attestation: "none",
      };
    },

    /** Enrols the credential `navigator.credentials.create` made, using up the code its challenge was issued for. */
    enrol(response: { clientDataJSON: string; attestationObject: string }, name: string, by: string): Passkey {
      const rp = relyingParty();
      let credential: ReturnType<typeof verifyRegistration>;
      try { credential = verifyRegistration(response, rp); } catch (err) { return refused(err); }
      const { purpose } = take(credential.challenge);
      if (purpose.kind !== "enrol") throw new HttpError(403, "the challenge was not made for an enrolment");
      if (registry.passkeyByCredential(credential.credentialId) !== null) throw new HttpError(409, "that passkey is enrolled already");
      const { challenge: _, ...stored } = credential;
      const passkey: Passkey = { id: `pk-${randomBytes(4).toString("hex")}`, name, ...stored, createdAt: now(), createdBy: by, lastUsedAt: null };
      if (!registry.enrolPasskey(passkey, purpose.code)) throw new HttpError(403, "the enrolment code was used or expired meanwhile. Make another on the control plane's host");
      return passkey;
    },

    /** The options for `navigator.credentials.get`, confirming `purpose` with any enrolled passkey. */
    challenge(purpose: Purpose) {
      const rp = relyingParty();
      const passkeys = registry.passkeys();
      if (passkeys.length === 0) throw new HttpError(409, "no passkey is enrolled. Enrol one on the dashboard's Passkeys page with a code from the control plane's host");
      return { challenge: issue(purpose), rpId: rp.id, timeout: challengeMs, userVerification: "required", allowCredentials: passkeys.map((p) => ({ type: "public-key", id: p.credentialId })) };
    },

    /**
     * Checks that an enrolled passkey, verifying the person, signed the challenge issued for exactly `purpose`, and
     * returns the passkey. The challenge is taken first, so a refused assertion cannot be tried again either.
     */
    confirm(assertion: Assertion, purpose: Purpose): Passkey {
      const rp = relyingParty();
      let challenge: string;
      try {
        challenge = JSON.parse(Buffer.from(assertion.clientDataJSON, "base64url").toString("utf8")).challenge;
      } catch { throw new HttpError(403, "the passkey's client data is not JSON"); }
      const confirmed = take(String(challenge));
      if (JSON.stringify(confirmed.purpose) !== JSON.stringify(purpose)) throw new HttpError(403, mismatch(confirmed.purpose, purpose));
      const passkey = registry.passkeyByCredential(assertion.id);
      if (passkey === null) throw new HttpError(403, "that passkey is not enrolled, or it was revoked");
      let signed: ReturnType<typeof verifyAssertion>;
      try { signed = verifyAssertion(assertion, passkey, rp); } catch (err) { return refused(err); }
      const used = { ...passkey, signCount: signed.signCount, lastUsedAt: now() };
      registry.savePasskeyUse(used);
      return used;
    },
  };
}
export type PasskeyGate = ReturnType<typeof passkeyGate>;

/**
 * The host command. Only root runs it, so an agent, which can call the API but never run a command as root on the
 * control plane's host, cannot make a code. It acts as the registry's owner, so the files SQLite creates stay the
 * control plane's.
 */
async function host(args: string[]) {
  const [configPath, command, id] = args;
  const usage = "usage: sudo node src/control/passkeys.ts <config.json> code | list | revoke <id>";
  if (configPath === undefined || !["code", "list", "revoke"].includes(command ?? "") || (command === "revoke") !== (id !== undefined)) {
    console.error(usage);
    process.exit(64);
  }
  if (process.getuid?.() !== 0) {
    console.error("passkeys: run this as root on the control plane's host. The code it makes is what lets a passkey enrol, so only root may make one");
    process.exit(77);
  }
  const { readConfig } = await import("./main.ts");
  const config = await readConfig(configPath);
  const owner = statSync(config.db);
  process.setgid!(owner.gid);
  process.setuid!(owner.uid);
  const registry = openRegistry(config.db);
  try {
    if (command === "code") {
      const { code, expiresAt } = newCode(registry);
      const url = config.https === undefined ? null : `https://${config.https.hostname}:7443/passkeys?code=${code}`;
      console.log(`${url ?? code}\nThe code ${code} enrols one passkey until ${new Date(expiresAt).toISOString()}.${url === null ? " The config has no https.hostname, so the dashboard cannot enrol it yet." : ""}`);
    } else if (command === "list") {
      const list = passkeyList(registry);
      console.log(list.length === 0 ? "No passkeys." : list.map((p) => `${p.id}  ${p.name}  enrolled ${new Date(p.createdAt).toISOString()} from ${p.createdBy}${p.lastUsedAt === null ? "" : `, last used ${new Date(p.lastUsedAt).toISOString()}`}`).join("\n"));
    } else {
      const revoked = registry.revokePasskey(id!, "root on the control plane's host");
      if (revoked === null) {
        console.error(`passkeys: no passkey ${id}`);
        process.exit(1);
      }
      console.log(`Revoked ${revoked.id}, ${revoked.name}.`);
    }
  } finally {
    registry.close();
  }
}

if (import.meta.main) await host(process.argv.slice(2));
