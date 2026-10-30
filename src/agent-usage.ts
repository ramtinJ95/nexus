/**
 * The model calls agents in a pylon recorded on its disk: Claude Code's transcripts, its subagents' included, and pi's
 * sessions, such as a harness reviewer's. agent-usage.py reads them in the guest from the offsets the last read reached
 * and prints only each call's usage, so a transcript of many megabytes costs a few hundred bytes a call over the pipe.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { claudeProjects } from "./claude-transcript.ts";
import type { AgentCall } from "./control/usage.ts";
import { openPython, pipeOutput, type OpenPipe } from "./pipe.ts";

const helper = readFileSync(new URL("./agent-usage.py", import.meta.url));

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
  const stream = await openPython(open, helper, [], "agent-usage.py");
  const input = Buffer.from(JSON.stringify({ ...logs, offsets: Object.fromEntries(offsets), limit: limitBytes }));
  const { out } = await pipeOutput(stream, { deadlineMs, maxBytes: maxReplyBytes, what: "its agents' usage", input });
  const lines = out.toString("utf8").split("\n").filter((line) => line !== "");
  const end = endSchema.parse(JSON.parse(lines.pop() ?? "null"));
  return { calls: lines.map((line) => callSchema.parse(JSON.parse(line))), offsets: new Map(Object.entries(end.offsets) as [string, FileCursor][]), more: end.more };
}
