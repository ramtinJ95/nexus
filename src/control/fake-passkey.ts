/**
 * A software authenticator for tests: it answers the options the passkey routes hand out with what a browser's
 * `navigator.credentials` would send back, an ES256 credential with a counter. Its flags and origin can be set to what
 * a real authenticator or a stolen session should never be able to send.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { Assertion } from "./webauthn.ts";

function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([major << 5 | n])
    : n < 256 ? Buffer.from([major << 5 | 24, n])
    : Buffer.from([major << 5 | 25, n >> 8, n & 255]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error(`cbor: ${typeof value}`);
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export function fakeAuthenticator(options: { origin: string; rpId?: string; verifies?: boolean; counter?: boolean } ) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(16);
  let count = 0;
  const flags = () => FLAG_UP | (options.verifies === false ? 0 : FLAG_UV);
  const authData = (rpId: string, extra: number, attested: Buffer = Buffer.alloc(0)) => {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(options.counter === false ? 0 : ++count);
    return Buffer.concat([sha256(options.rpId ?? rpId), Buffer.from([flags() | extra]), counter, attested]);
  };
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin: options.origin, crossOrigin: false }));
  return {
    id: credentialId.toString("base64url"),
    /** What `navigator.credentials.create` sends back for the enrolment options. */
    create(o: { challenge: string; rp: { id: string } }) {
      const jwk = publicKey.export({ format: "jwk" });
      const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const data = authData(o.rp.id, FLAG_AT, Buffer.concat([Buffer.alloc(16), length, credentialId, cbor(cose)]));
      return {
        clientDataJSON: clientData("webauthn.create", o.challenge).toString("base64url"),
        attestationObject: cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", data]])).toString("base64url"),
      };
    },
    /** What `navigator.credentials.get` sends back for a challenge's options. */
    get(o: { challenge: string; rpId: string }): Assertion {
      const data = authData(o.rpId, 0);
      const client = clientData("webauthn.get", o.challenge);
      return {
        id: credentialId.toString("base64url"), clientDataJSON: client.toString("base64url"), authenticatorData: data.toString("base64url"),
        signature: sign("sha256", Buffer.concat([data, sha256(client)]), privateKey).toString("base64url"),
      };
    },
  };
}
