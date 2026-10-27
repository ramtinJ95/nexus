/**
 * The server's half of WebAuthn, as far as passkeys on the dashboard need it: reading a new credential and checking
 * an assertion, with node:crypto and no dependency. Registration asks for no attestation, so it trusts the public key
 * the browser hands over. What makes that key the person's is the enrolment code it came with (passkeys.ts).
 */
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";

/** The relying party: the dashboard's HTTPS origin and its host, which every credential and assertion is bound to. */
export interface RelyingParty { id: string; origin: string }

export class WebAuthnError extends Error {}

const fail = (message: string): never => { throw new WebAuthnError(message); };

/** Decodes the CBOR subset that authenticators write: integers, byte and text strings, arrays, maps and simple values. */
export function decodeCbor(bytes: Uint8Array): { value: unknown; end: number } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (at: number): { value: unknown; end: number } => {
    if (at >= buf.length) fail("the CBOR ends early");
    const major = buf[at]! >> 5;
    const info = buf[at]! & 31;
    let n: number;
    let next = at + 1;
    if (info < 24) n = info;
    else if (info === 24) { n = buf.readUInt8(next); next += 1; }
    else if (info === 25) { n = buf.readUInt16BE(next); next += 2; }
    else if (info === 26) { n = buf.readUInt32BE(next); next += 4; }
    else if (info === 27) { n = Number(buf.readBigUInt64BE(next)); next += 8; }
    else return fail("indefinite lengths are not supported");
    switch (major) {
      case 0: return { value: n, end: next };
      case 1: return { value: -1 - n, end: next };
      case 2: case 3: {
        if (next + n > buf.length) fail("a CBOR string runs past the end");
        const slice = buf.subarray(next, next + n);
        return { value: major === 2 ? Buffer.from(slice) : slice.toString("utf8"), end: next + n };
      }
      case 4: {
        const items: unknown[] = [];
        for (let i = 0; i < n; i++) { const item = read(next); items.push(item.value); next = item.end; }
        return { value: items, end: next };
      }
      case 5: {
        const map = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) {
          const key = read(next);
          const value = read(key.end);
          map.set(key.value, value.value);
          next = value.end;
        }
        return { value: map, end: next };
      }
      case 7: return { value: info === 20 ? false : info === 21 ? true : null, end: next };
      default: return fail(`CBOR major type ${major} is not supported`);
    }
  };
  return read(0);
}

/** What the authenticator data says: who it is for, whether the person was present and verified, and the counter. */
export interface AuthenticatorData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  /** Present at registration: the new credential's ID and its COSE public key. */
  credential: { id: Buffer; publicKey: Map<unknown, unknown> } | null;
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) fail("the authenticator data is too short");
  const flags = data[32]!;
  const attested = (flags & 0x40) !== 0;
  let credential: AuthenticatorData["credential"] = null;
  if (attested) {
    if (data.length < 55) fail("the attested credential data is too short");
    const length = data.readUInt16BE(53);
    const id = data.subarray(55, 55 + length);
    const key = decodeCbor(data.subarray(55 + length));
    if (!(key.value instanceof Map)) fail("the credential's public key is not a COSE key");
    credential = { id: Buffer.from(id), publicKey: key.value as Map<unknown, unknown> };
  }
  return { rpIdHash: data.subarray(0, 32), userPresent: (flags & 0x01) !== 0, userVerified: (flags & 0x04) !== 0, signCount: data.readUInt32BE(33), credential };
}

/** The COSE algorithms passkeys use: ES256, EdDSA and RS256. */
export const algorithms = [-7, -8, -257] as const;
type Algorithm = typeof algorithms[number];

function coseKey(cose: Map<unknown, unknown>): { key: KeyObject; algorithm: Algorithm } {
  const algorithm = cose.get(3);
  const b64 = (v: unknown) => Buffer.isBuffer(v) ? v.toString("base64url") : fail("a COSE key coordinate is missing");
  switch (algorithm) {
    case -7:
      if (cose.get(1) !== 2 || cose.get(-1) !== 1) fail("an ES256 key must be an EC2 key on P-256");
      return { algorithm, key: createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64(cose.get(-2)), y: b64(cose.get(-3)) } }) };
    case -8:
      if (cose.get(1) !== 1 || cose.get(-1) !== 6) fail("an EdDSA key must be an OKP key on Ed25519");
      return { algorithm, key: createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: b64(cose.get(-2)) } }) };
    case -257:
      if (cose.get(1) !== 3) fail("an RS256 key must be an RSA key");
      return { algorithm, key: createPublicKey({ format: "jwk", key: { kty: "RSA", n: b64(cose.get(-1)), e: b64(cose.get(-2)) } }) };
    default: return fail(`COSE algorithm ${String(algorithm)} is not supported`);
  }
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Checks the client data the browser signed over: its type, the challenge the server issued and the origin. */
function clientData(json: Buffer, type: "webauthn.create" | "webauthn.get", rp: RelyingParty): { challenge: string } {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { data = JSON.parse(json.toString("utf8")) as typeof data; } catch { return fail("the client data is not JSON"); }
  if (data.type !== type) fail(`the client data is for ${String(data.type)}, not ${type}`);
  if (typeof data.challenge !== "string") fail("the client data has no challenge");
  if (data.origin !== rp.origin) fail(`the passkey was used on ${String(data.origin)}, not the dashboard's ${rp.origin}`);
  if (data.crossOrigin === true) fail("the passkey was used in a frame from another origin");
  return { challenge: data.challenge as string };
}

function authenticator(data: Buffer, rp: RelyingParty): AuthenticatorData {
  const parsed = parseAuthenticatorData(data);
  if (!same(parsed.rpIdHash, sha256(rp.id))) fail(`the passkey is for another site than ${rp.id}`);
  if (!parsed.userPresent) fail("the authenticator did not see the person present");
  if (!parsed.userVerified) fail("the authenticator did not verify the person, with a PIN or biometrics");
  return parsed;
}

/** A credential as the registry keeps it: its ID, its public key as SPKI DER, and the counter it last reported. */
export interface StoredCredential { credentialId: string; publicKey: string; algorithm: number; signCount: number }

/** Reads a new credential from `navigator.credentials.create`'s response, base64url fields as the client sends them. */
export function verifyRegistration(response: { clientDataJSON: string; attestationObject: string }, rp: RelyingParty): StoredCredential & { challenge: string } {
  const { challenge } = clientData(Buffer.from(response.clientDataJSON, "base64url"), "webauthn.create", rp);
  const attestation = decodeCbor(Buffer.from(response.attestationObject, "base64url")).value;
  if (!(attestation instanceof Map) || !Buffer.isBuffer(attestation.get("authData"))) fail("the attestation object has no authenticator data");
  const data = authenticator((attestation as Map<string, Buffer>).get("authData")!, rp);
  if (data.credential === null) fail("the authenticator data names no new credential");
  const { key, algorithm } = coseKey(data.credential!.publicKey);
  return {
    challenge, credentialId: data.credential!.id.toString("base64url"), algorithm, signCount: data.signCount,
    publicKey: key.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/** An assertion from `navigator.credentials.get`, base64url fields as the client sends them. */
export interface Assertion { id: string; clientDataJSON: string; authenticatorData: string; signature: string }

/**
 * Checks an assertion's signature with the stored credential, and returns the counter to store. A counter that does
 * not move past the stored one means a cloned authenticator, except that authenticators without one always say 0.
 */
export function verifyAssertion(assertion: Assertion, credential: StoredCredential, rp: RelyingParty): { signCount: number; challenge: string } {
  if (assertion.id !== credential.credentialId) fail("the assertion is from another credential");
  const clientDataJSON = Buffer.from(assertion.clientDataJSON, "base64url");
  const { challenge } = clientData(clientDataJSON, "webauthn.get", rp);
  const data = Buffer.from(assertion.authenticatorData, "base64url");
  const parsed = authenticator(data, rp);
  const key = createPublicKey({ key: Buffer.from(credential.publicKey, "base64"), format: "der", type: "spki" });
  const signed = Buffer.concat([data, sha256(clientDataJSON)]);
  const signature = Buffer.from(assertion.signature, "base64url");
  if (!verify(credential.algorithm === -8 ? null : "sha256", signed, key, signature)) fail("the passkey's signature does not verify");
  if ((parsed.signCount !== 0 || credential.signCount !== 0) && parsed.signCount <= credential.signCount) {
    fail(`the passkey's signature counter went from ${credential.signCount} to ${parsed.signCount}, as a cloned authenticator's would`);
  }
  return { signCount: parsed.signCount, challenge };
}
