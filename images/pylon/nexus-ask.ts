/**
 * The pylon's side of answering a Claude worker's AskUserQuestion from the dashboard. Claude Code runs
 * `nexus-claude-hook ask` at AskUserQuestion's PreToolUse, which records the call's ID, and then as its
 * PermissionRequest hook while the terminal dialog shows, which waits for an answer file. The control plane runs
 * `nexus-claude-hook asks` through the probe to learn which asks wait, and `nexus-claude-hook answer` to write an
 * answer, which the waiting hook hands to Claude as the tool's input. An ask is named by askKey, and its files in
 * ~/.nexus/asks are:
 *   <key>.call                the call's ID from PreToolUse, which the PermissionRequest hook takes
 *   <session>.<key>.waiting   the hook that waits and the ask it waits for, a Waiting
 *   <key>.<call>.answer       the answer written for the call, which its hook takes
 *   <key>.<call>.delivered    the answer the hook handed to Claude, so a retried delivery of it still succeeds
 * Claude Code's PermissionRequest input names no tool call, so the key is the session and the questions' texts, and
 * <call> is the SHA-256 of the call's ID, so an answer meant for one call is never another's. <session> is the
 * SHA-256 of the session, so the end of a session's turn finds its waiting files by name.
 */
import { createHash } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { answerDelivered, answerExits, maxAsksBytes, type AskAnswer } from "./nexus-contract.ts";
import { startTime } from "./nexus-heartbeat.ts";

/** An ask whose hook waits, as `nexus-claude-hook asks` prints it: the call and its input as Claude gave it. */
export interface ReportedAsk { session: string; toolUseId: string; at: number; input: Record<string, unknown> }

/**
 * What `<session>.<key>.waiting` holds. `start` is when the hook's process started, in clock ticks since boot, so a
 * pid that a pause or a killed hook freed for another process is not taken for the hook. It is null where there is no
 * /proc. `at` is when the hook started waiting, and `toolUseId` is null when no PreToolUse recorded the call. The file
 * starts with `pid`, `start` and `at`, which name the hook that wrote it.
 */
interface Waiting { pid: number; start: number | null; at: number; session: string; toolUseId: string | null; input: Record<string, unknown> }

/** `asks` leaves out a waiting file over maxWaitingBytes, and prints at most maxAsksBytes. */
const maxWaitingBytes = 256 << 10;

/** How much of a hook's input is read: any hook's up to maxReportInput, and AskUserQuestion's up to maxAskInput, since its previews make it long. */
const maxReportInput = 64 << 10;
const maxAskInput = 4 << 20;

/**
 * A hook's input, or null when it is too long. An AskUserQuestion call's input holds every option's preview, twice in
 * its PostToolUse, which must still end the wait of an ask the terminal answered.
 */
export async function hookInput(chunks: AsyncIterable<string | Buffer> | Iterable<string | Buffer>): Promise<Record<string, unknown> | null> {
  let input = "";
  for await (const chunk of chunks) {
    input += chunk;
    if (input.length > maxAskInput) return null;
  }
  const payload = JSON.parse(input);
  return input.length <= maxReportInput || payload?.tool_name === "AskUserQuestion" ? payload : null;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export const askKey = (session: string, questions: readonly string[]): string => sha256(`${session}\n${JSON.stringify(questions)}`);

/** The question texts of Claude's AskUserQuestion input, or null for an input that has none. */
export function askedTexts(input: unknown): string[] | null {
  const questions = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const texts = questions.map((q) => (q as { question?: unknown } | null)?.question);
  return texts.every((text) => typeof text === "string") ? texts as string[] : null;
}

/** The argument `nexus-claude-hook answer` takes, or null when it is not an AskAnswer. */
export function parseAskAnswer(text: string): AskAnswer | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  const record = (v: unknown, each: (item: unknown) => boolean) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(each);
  const strings = (v: unknown) => record(v, (s) => typeof s === "string");
  const { session, questions, toolUseId, answers, annotations } = (record(value, () => true) ? value : {}) as Partial<Record<keyof AskAnswer, unknown>>;
  const valid = typeof session === "string" && Array.isArray(questions) && questions.length > 0 && questions.every((q) => typeof q === "string")
    && typeof toolUseId === "string"
    && strings(answers) && record(annotations, strings);
  return valid ? value as AskAnswer : null;
}

/**
 * The decision a PermissionRequest hook prints to answer AskUserQuestion: Claude's own input with the answer added.
 * A single-select pick's preview goes in its annotation, as Claude's terminal puts it, from this input, since the
 * transcript the control plane reads cuts long strings.
 */
export function askDecision(input: Record<string, unknown>, answer: Pick<AskAnswer, "answers" | "annotations">) {
  const annotations: Record<string, { preview?: string; notes?: string }> = { ...answer.annotations };
  for (const q of Array.isArray(input.questions) ? input.questions as { question?: unknown; multiSelect?: unknown; options?: unknown }[] : []) {
    if (typeof q?.question !== "string" || q.multiSelect === true || !Array.isArray(q.options)) continue;
    const picked = (q.options as { label?: unknown; preview?: unknown }[]).find((o) => o?.label === answer.answers[q.question as string]);
    if (typeof picked?.preview === "string") annotations[q.question] = { preview: picked.preview, ...annotations[q.question] };
  }
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { ...input, answers: answer.answers, annotations } } } };
}

const recordedCall = (dir: string, key: string) => join(dir, `${key}.call`);
const waitingFile = (dir: string, session: string, key: string) => join(dir, `${sha256(session)}.${key}.waiting`);
const callFile = (dir: string, key: string, toolUseId: string, kind: "answer" | "delivered") => join(dir, `${key}.${sha256(toolUseId)}.${kind}`);
const contentOf = (answer: Pick<AskAnswer, "answers" | "annotations">) => JSON.stringify({ answers: answer.answers, annotations: answer.annotations });
const read = (path: string) => readFile(path, "utf8").catch(() => null);

/** Writes the file whole, so no reader sees part of it. */
async function writeWhole(path: string, content: string) {
  await writeFile(`${path}.${process.pid}`, content);
  await rename(`${path}.${process.pid}`, path);
}

/** The file's JSON, or null for no file or one that is not JSON. */
function jsonOf(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return null;
  }
}

/** The waiting file's record, or null for none, such as the bare pid an image from before the record wrote. */
function waitingOf(text: string | null): Waiting | null {
  const waiting = jsonOf(text) as Partial<Waiting> | null;
  return typeof waiting?.pid === "number" ? waiting as Waiting : null;
}

/** Whether the process lives, which a pid this user may not signal does too. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When the process started, in clock ticks since boot, or null for none or where there is no /proc. */
async function startOf(pid: number): Promise<number | null> {
  const stat = await read(`/proc/${pid}/stat`);
  return stat === null ? null : startTime(stat);
}

/** Whether the file starts with `prefix`, read with one short read rather than whole. */
async function startsWith(path: string, prefix: Buffer): Promise<boolean> {
  const handle = await open(path).catch(() => null);
  if (handle === null) return false;
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(prefix.length), 0, prefix.length, 0);
    return bytesRead === prefix.length && buffer.equals(prefix);
  } finally {
    await handle.close();
  }
}

/** Renames the file, or answers false when it is not there. */
const renamed = (from: string, to: string) => rename(from, to).then(() => true, (err: NodeJS.ErrnoException) => {
  if (err.code === "ENOENT") return false;
  throw err;
});

/** Whether the hook that wrote the waiting file still runs. */
const waits = async (waiting: Waiting) => alive(waiting.pid) && await startOf(waiting.pid) === waiting.start;

/**
 * Records the call's ID for its ask, as `nexus-claude-hook ask` does at AskUserQuestion's PreToolUse, whose input has
 * it. Claude finishes its PreToolUse hooks before it asks for permission, so the PermissionRequest hook finds it.
 */
export async function recordCall(dir: string, session: string, input: unknown, toolUseId: string): Promise<void> {
  const texts = askedTexts(input);
  if (texts === null) return;
  await mkdir(dir, { recursive: true });
  await writeWhole(recordedCall(dir, askKey(session, texts)), JSON.stringify({ toolUseId }));
}

/**
 * Waits, as `nexus-claude-hook ask` does at AskUserQuestion's PermissionRequest, for the ask's answer, and answers it
 * once it is written, or null to leave the dialog to the terminal: at once for an input with no questions, once the
 * waiting file is no longer this hook's, as after PostToolUse removed it when the terminal answered, or once `claude`
 * says Claude is gone. The waiting file takes the call's ID that PreToolUse recorded, and without one no answer can
 * name the call. Answers and deliveries left by earlier asks of the same questions in the session are removed first.
 * `waiting` runs once the waiting file is written, so the control plane's pull after the event it reports lists the ask.
 */
export async function awaitAnswer(
  dir: string, asked: { session: string; input: Record<string, unknown>; pid: number; at: number }, claude: () => boolean,
  { sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 500)), waiting }: { sleep?: () => Promise<void>; waiting?: () => Promise<void> } = {},
): Promise<Pick<AskAnswer, "answers" | "annotations"> | null> {
  const texts = askedTexts(asked.input);
  if (texts === null) return null;
  const key = askKey(asked.session, texts);
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) {
    if (name.startsWith(`${key}.`) && (name.endsWith(".answer") || name.endsWith(".delivered"))) await rm(join(dir, name), { force: true });
  }
  const call = (jsonOf(await read(recordedCall(dir, key))) as { toolUseId?: unknown } | null)?.toolUseId;
  await rm(recordedCall(dir, key), { force: true });
  const toolUseId = typeof call === "string" ? call : null;
  const waitingPath = waitingFile(dir, asked.session, key);
  const hook = { pid: asked.pid, start: await startOf(asked.pid), at: asked.at };
  const mine = JSON.stringify({ ...hook, session: asked.session, toolUseId, input: asked.input } satisfies Waiting);
  // The record up to the comma after `at`, which no other hook's file starts with.
  const token = Buffer.from(mine.slice(0, JSON.stringify(hook).length));
  await writeWhole(waitingPath, mine);
  await waiting?.();
  for (;;) {
    if (!await startsWith(waitingPath, token)) return null;
    if (!claude()) {
      await rm(waitingPath, { force: true });
      return null;
    }
    if (toolUseId !== null && await renamed(callFile(dir, key, toolUseId, "answer"), callFile(dir, key, toolUseId, "delivered"))) {
      const answer = await read(callFile(dir, key, toolUseId, "delivered"));
      await rm(waitingPath, { force: true });
      return JSON.parse(answer!) as Pick<AskAnswer, "answers" | "annotations">;
    }
    await sleep();
  }
}

/**
 * Hands the answer to the hook that waits for its call, as `nexus-claude-hook answer` does, and answers the exit code
 * once the hook has taken it. The answer file is created whole and only once, so of two different answers one is
 * refused, while the same answer again, before or after the hook took it, succeeds. When the call no longer waits, or
 * its hook has not taken the answer within giveUpMs, the answer is taken back by a rename that races the hook's own,
 * so exactly one of them has it. A dialog the terminal answered stays open to the hook until its PostToolUse runs,
 * and an answer the hook takes then is delivered though Claude has the terminal's. Only Claude could close that gap.
 */
export async function deliverAnswer(
  dir: string, answer: AskAnswer,
  { sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 50)), giveUpMs = 5_000 }: { sleep?: () => Promise<void>; giveUpMs?: number } = {},
): Promise<number> {
  const key = askKey(answer.session, answer.questions);
  const answerFile = callFile(dir, key, answer.toolUseId, "answer");
  const content = contentOf(answer);
  const delivered = async () => await read(callFile(dir, key, answer.toolUseId, "delivered")) === content;
  if (await delivered()) return answerExits.delivered;
  const waitingPath = waitingFile(dir, answer.session, key);
  const waitingText = await read(waitingPath);
  const waiter = waitingOf(waitingText);
  if (waiter?.toolUseId !== answer.toolUseId || !await waits(waiter)) return answerExits.nobodyWaits;
  const temp = `${answerFile}.${process.pid}`;
  await writeFile(temp, content);
  try {
    await link(temp, answerFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (await read(answerFile) !== content && !await delivered()) return answerExits.answeredOtherwise;
  } finally {
    await rm(temp, { force: true });
  }
  const giveUp = Date.now() + giveUpMs;
  while (!await delivered()) {
    if (await read(waitingPath) !== waitingText || !await waits(waiter) || Date.now() >= giveUp) {
      const back = `${answerFile}.${process.pid}.back`;
      if (await renamed(answerFile, back)) await rm(back, { force: true });
      return await delivered() ? answerExits.delivered : answerExits.nobodyWaits;
    }
    await sleep();
  }
  return answerExits.delivered;
}

/**
 * The asks whose hooks wait now and know their call, newest first, as `nexus-claude-hook asks` prints them. A waiting
 * file over maxWaitingBytes is left out, and so is every ask after the one that would pass maxAsksBytes.
 */
export async function waitingAsks(dir: string): Promise<ReportedAsk[]> {
  const asks: ReportedAsk[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const path = join(dir, name);
    if (!name.endsWith(".waiting") || ((await stat(path).catch(() => null))?.size ?? Infinity) > maxWaitingBytes) continue;
    const waiting = waitingOf(await read(path));
    if (waiting?.toolUseId == null || !await waits(waiting)) continue;
    asks.push({ session: waiting.session, toolUseId: waiting.toolUseId, at: waiting.at, input: waiting.input });
  }
  const printed: ReportedAsk[] = [];
  let bytes = 2;
  for (const ask of asks.sort((a, b) => b.at - a.at)) {
    bytes += Buffer.byteLength(JSON.stringify(ask)) + 1;
    if (bytes > maxAsksBytes) break;
    printed.push(ask);
  }
  return printed;
}

/** Ends the wait of the ask Claude has an answer to, as its PostToolUse does, so a hook whose dialog the terminal answered stops. */
export async function forgetAsk(dir: string, session: string, input: unknown): Promise<void> {
  const texts = askedTexts(input);
  if (texts === null) return;
  const key = askKey(session, texts);
  await rm(waitingFile(dir, session, key), { force: true });
  await rm(recordedCall(dir, key), { force: true });
}

/**
 * Ends the wait of every ask of the session, as the start or end of its turn and the end of the session do, since no
 * dialog of it shows then. A dialog that closed without a PostToolUse, such as one the person interrupted, may have
 * left its hook waiting.
 */
export async function forgetSession(dir: string, session: string): Promise<void> {
  const prefix = `${sha256(session)}.`;
  for (const name of await readdir(dir).catch(() => [])) {
    if (name.startsWith(prefix) && name.endsWith(".waiting")) await rm(join(dir, name), { force: true });
  }
}
