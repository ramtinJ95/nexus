import { createHash } from "node:crypto";

/** Hex sha256 of canonical JSON: object keys sorted, so the same value always gives the same hash. */
export function canonicalSha256(value: unknown): string {
  const canonical = (v: unknown): unknown => typeof v !== "object" || v === null ? v
    : Array.isArray(v) ? v.map(canonical)
    : Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical((v as Record<string, unknown>)[key])]));
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
