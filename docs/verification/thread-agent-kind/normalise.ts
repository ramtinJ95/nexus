// Shared by the capture scripts in this directory: stable placeholders for what differs from run to run, and short
// spellings of long values, so two runs of the same code print the same lines.
import { createHash } from "node:crypto";

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const agentName = /\bnx-[0-9a-f]{8}\b/g;
const isoTime = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g;

/**
 * Numbers each random UUID and Herdr agent name by first appearance, so a value that recurs, such as a fresh Claude
 * session ID in its launch and in the sessions file, keeps one placeholder. Make one per case, so a case's numbering
 * does not depend on the cases before it.
 */
export function normaliser() {
  const seen = new Map<string, string>();
  const placeholder = (kind: string) => (value: string) => {
    if (!seen.has(value)) seen.set(value, `<${kind}-${[...seen.values()].filter((v) => v.startsWith(`<${kind}-`)).length + 1}>`);
    return seen.get(value)!;
  };
  return (text: string) => text.replace(uuid, placeholder("uuid")).replace(agentName, placeholder("agent")).replace(isoTime, "<time>");
}

/** A string too long or too multi-line to read in a line, as its length and a hash, so a change still shows. */
export function short(value: string, limit = 160): string {
  if (value.length <= limit && !value.includes("\n")) return value;
  const first = value[0]!;
  if (value === first.repeat(value.length)) return `<${first} x ${value.length}>`;
  return `<${value.length} chars sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}>`;
}

/** JSON with every long string shortened. */
export function json(value: unknown, limit = 160): string {
  return JSON.stringify(value, (_key, v: unknown) => typeof v === "string" ? short(v, limit) : v);
}
