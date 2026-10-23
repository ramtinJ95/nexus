/**
 * Declared outputs inside a pylon: what the agent names with `nexus output add` beyond the outputs Nexus
 * records on its own. Each is one JSON record under /home/user/.nexus/outputs/, written by the probe through a
 * guest exec as `user`, so the checkpoint carries it and the next observation reports it. A diff output also
 * keeps the diff itself beside its record.
 *
 * The directory is the guest's, so every record read back is parsed as untrusted input.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Guest } from "./backend.ts";
import type { DeclaredOutput } from "./protocol.ts";
import { checkoutDir } from "./sessions.ts";

export const outputsDir = "/home/user/.nexus/outputs";

export type OutputDeclaration = { kind: "file"; path: string; title?: string } | { kind: "diff"; title?: string };

/** A refusal the agent can act on, such as a missing file or a clean tree, rather than a failed guest. */
export class OutputRefused extends Error {}

const callTimeoutMs = 10_000;
/**
 * The pylon VM backend returns at most 64 KiB of a command's output (src/pylon-vm/processes.ts), and the listing
 * is one command. The probe is the only writer, so it refuses an output that would take the listing past this.
 */
const listingBudgetBytes = 60_000;
/** A diff of a large tree can take a while to write. */
const diffTimeoutMs = 60_000;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const outputId = z.string().regex(/^out-[0-9a-z]+-[0-9a-f]{8}$/);
const recordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: outputId, kind: z.literal("file"), path: z.string().startsWith("/"), title: z.string().nullable(), sha256 }),
  z.strictObject({ id: outputId, kind: z.literal("diff"), base: z.string().regex(/^[0-9a-f]{40,64}$/), sha256, title: z.string().nullable() }),
]);

function parseRecord(text: string): DeclaredOutput | null {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // not JSON
  }
}

/** The bytes one record takes in the listing. */
const listingBytes = (o: DeclaredOutput): number => Buffer.byteLength(`${o.id}.json\t${JSON.stringify(o)}\n`);

/** Time first, so the directory lists in the order outputs were declared. */
const newOutputId = () => `out-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

async function sh(guest: Guest, script: string, args: readonly string[], cwd: string, timeoutMs = callTimeoutMs) {
  return guest.exec(["sh", "-c", script, "sh", ...args], { cwd, timeoutMs });
}

/**
 * A file output records the file's path and its digest now. The file is not copied, so a later change shows as
 * a digest mismatch. A diff output snapshots the checkout against HEAD, untracked files included, through a
 * scratch index so the agent's own index is left alone. A clean tree is refused.
 */
export async function addOutput(guest: Guest, declaration: OutputDeclaration): Promise<DeclaredOutput> {
  const listed = (await listOutputs(guest)).reduce((bytes, o) => bytes + listingBytes(o), 0);
  const id = newOutputId();
  const title = declaration.title ?? null;
  let output: DeclaredOutput;
  if (declaration.kind === "file") {
    const { path } = declaration;
    const digest = await sh(guest, 'test -f "$1" || { echo "$1 is not a file"; exit 3; }; sha256sum < "$1"', [path], "/");
    if (digest.exitCode === 3) throw new OutputRefused(digest.output.trim());
    if (digest.exitCode !== 0) throw new Error(`hashing ${path} failed with exit ${digest.exitCode}: ${digest.output}`);
    output = { id, kind: "file", path, title, sha256: digest.output.slice(0, 64) };
  } else {
    const diff = await sh(guest, [
      "set -e",
      `mkdir -p ${outputsDir}`,
      `export GIT_INDEX_FILE="${outputsDir}/$1.index"`,
      'trap \'rm -f "$GIT_INDEX_FILE"\' EXIT',
      "git read-tree HEAD && git add -A",
      // The agent's git config must not change what the diff is, such as by coloring it or by mnemonic prefixes.
      `git diff --cached --binary --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ HEAD > "${outputsDir}/$1.diff"`,
      `if ! test -s "${outputsDir}/$1.diff"; then rm "${outputsDir}/$1.diff"; echo "the working tree has no changes against HEAD"; exit 3; fi`,
      "git rev-parse HEAD",
      `sha256sum < "${outputsDir}/$1.diff"`,
    ].join("\n"), [id], checkoutDir, diffTimeoutMs);
    if (diff.exitCode === 3) throw new OutputRefused(diff.output.trim());
    if (diff.exitCode !== 0) throw new Error(`snapshotting the working tree failed with exit ${diff.exitCode}: ${diff.output}`);
    const [base, digest] = diff.output.trim().split("\n");
    output = { id, kind: "diff", base: base!, sha256: digest!.slice(0, 64), title };
  }
  const record = recordSchema.parse(output);
  if (listed + listingBytes(record) > listingBudgetBytes) {
    if (record.kind === "diff") await sh(guest, `rm -f "${outputsDir}/$1.diff"`, [id], "/");
    throw new OutputRefused(`this pylon's declared outputs would pass the ${listingBudgetBytes} bytes the probe reads back. Declare fewer, or shorter titles and paths`);
  }
  // Renamed into place, so a listing never reads half a record.
  const write = await sh(guest, `mkdir -p ${outputsDir} && printf '%s\\n' "$2" > "${outputsDir}/$1.json.partial" && mv "${outputsDir}/$1.json.partial" "${outputsDir}/$1.json"`, [id, JSON.stringify(record)], "/");
  if (write.exitCode !== 0) throw new Error(`recording output ${id} failed with exit ${write.exitCode}: ${write.output}`);
  return output;
}

/** In declaration order. Throws on a record that is not one this module wrote, naming its file. */
export async function listOutputs(guest: Guest, timeoutMs = callTimeoutMs): Promise<DeclaredOutput[]> {
  const listing = await sh(guest, `for f in ${outputsDir}/*.json; do test -e "$f" || continue; printf '%s\\t' "\${f##*/}"; cat "$f"; done`, [], "/", timeoutMs);
  if (listing.exitCode !== 0) throw new Error(`listing ${outputsDir} failed with exit ${listing.exitCode}: ${listing.output}`);
  if (listing.truncated) throw new Error(`listing ${outputsDir} passed the guest's output limit, so ${outputsDir} holds more than the probe wrote`);
  return listing.output.split("\n").filter((line) => line !== "").map((line) => {
    const tab = line.indexOf("\t");
    const file = line.slice(0, tab);
    const record = tab === -1 ? null : parseRecord(line.slice(tab + 1));
    if (record === null || `${record.id}.json` !== file) throw new Error(`${outputsDir}/${file} is not an output record Nexus wrote`);
    return record;
  });
}
