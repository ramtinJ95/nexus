/**
 * The model calls agents in a pylon recorded on its disk: Claude Code's transcripts, its subagents' included, and pi's
 * sessions, such as a harness reviewer's. agent-usage.py reads them in the guest from the offsets the last read reached
 * and prints only each call's usage, so a transcript of many megabytes costs a few hundred bytes a call over the pipe.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { OpenPipe } from "./checkout-files.ts";
import { claudeProjects } from "./claude-transcript.ts";
import type { AgentCall } from "./control/usage.ts";

const helper = readFileSync(new URL("./agent-usage.py", import.meta.url), "utf8");

/** Where a pylon's agents keep their transcripts. */
export const agentLogs = { claude: claudeProjects, pi: "/home/user/.pi/agent/sessions" };
/** The calls one read prints at most, roughly. A pylon with more is read again from where this read stopped. */
const limitBytes = 1 << 20;
const maxReplyBytes = 4 * limitBytes;
export const usageReadDeadlineMs = 60_000;

/**
 * A guest's counts are bounded, so no sum of them can pass what SQLite's integers hold. No model call reads a billion
 * tokens. Its ID must name its own agent, so a pylon cannot write over a call of the harness or of another agent.
 */
const tokens = z.int().nonnegative().max(1e9);
const callSchema = z.strictObject({
  id: z.string().max(1000), agent: z.enum(["claude", "pi"]), model: z.string().min(1).max(200), at: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  input: tokens, output: tokens, cacheWrite: tokens, cacheRead: tokens,
}).refine((c) => c.id.startsWith(`${c.agent}:`) && c.id.length > c.agent.length + 1, "a call's ID must name its agent");
/** Where a read of a file stopped, and the SHA-256 of the up to 4 KiB before it, which a replaced file does not match. */
export type FileCursor = [offset: number, before: string];
const cursorSchema = z.tuple([z.int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[0-9a-f]{64}$/)]);
const endSchema = z.strictObject({ offsets: z.record(z.string().min(1).max(4096), cursorSchema), more: z.boolean() });

export interface UsageRead { calls: AgentCall[]; offsets: Map<string, FileCursor>; more: boolean }

/** The calls recorded past `offsets`, and where the read stopped in each file it moved on in. */
export async function readAgentUsage(open: OpenPipe, offsets: ReadonlyMap<string, FileCursor>, logs = agentLogs, deadlineMs = usageReadDeadlineMs): Promise<UsageRead> {
  const stream = await open(["python3", "-c", helper]);
  const reply = (async () => {
    await stream.write(Buffer.from(JSON.stringify({ ...logs, offsets: Object.fromEntries(offsets), limit: limitBytes })));
    await stream.close();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxReplyBytes) throw new Error(`the usage reader printed over ${maxReplyBytes} bytes`);
      chunks.push(chunk);
    }
    return { end: await stream.done, out: Buffer.concat(chunks).toString("utf8") };
  })();
  // A reply that loses the race fails unwatched.
  reply.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the pylon did not read its agents' usage within ${deadlineMs / 1000} s`)), deadlineMs);
  });
  let result: Awaited<typeof reply>;
  try {
    result = await Promise.race([reply, late]);
  } catch (err) {
    stream.abort();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (result.end.kind === "lost") throw new Error("the pipe to the pylon was lost before its agents' usage was read");
  if (result.end.code !== 0) throw new Error(`reading the agents' usage exited ${result.end.code}`);
  const lines = result.out.split("\n").filter((line) => line !== "");
  const end = endSchema.parse(JSON.parse(lines.pop() ?? "null"));
  return { calls: lines.map((line) => callSchema.parse(JSON.parse(line))), offsets: new Map(Object.entries(end.offsets) as [string, FileCursor][]), more: end.more };
}
