/**
 * The pylon's side of answering a Claude worker's AskUserQuestion from the dashboard. Claude Code runs
 * `nexus-claude-hook ask` as a PermissionRequest hook while its terminal dialog shows, and the hook waits for an
 * answer file. The control plane writes one with `nexus-claude-hook answer`, which it runs through the probe, and the
 * waiting hook hands it to Claude as the tool's input. An ask is named by askKey, and its files in ~/.nexus/asks are:
 *   <key>.waiting    the pid of the hook that waits
 *   <key>.answer     the answer written for it, which the hook takes
 *   <key>.delivered  the answer the hook handed to Claude, so a retried delivery of it still succeeds
 * Claude Code's PermissionRequest input names no tool call, so the key is the session and the questions' texts.
 */
import { createHash } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the control plane hands `nexus-claude-hook answer`: the session and question texts that name the ask, and
 * Claude's `answers` and `annotations`. An answer maps each question's text to the picked labels and the person's
 * own answer, joined with ", ".
 */
export interface AskAnswer {
  session: string;
  questions: readonly string[];
  answers: Readonly<Record<string, string>>;
  annotations: Readonly<Record<string, { notes?: string }>>;
}

/**
 * `nexus-claude-hook answer`'s exit codes. A delivery also prints answerDelivered, since the hook of an image from
 * before asks exits 0 for a kind it does not know.
 */
export const answerExits = { delivered: 0, nobodyWaits: 20, answeredOtherwise: 21, malformed: 64 } as const;
export const answerDelivered = "delivered";

export const askKey = (session: string, questions: readonly string[]): string => createHash("sha256").update(`${session}\n${JSON.stringify(questions)}`).digest("hex");

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
  const { session, questions, answers, annotations } = (record(value, () => true) ? value : {}) as Partial<Record<keyof AskAnswer, unknown>>;
  const valid = typeof session === "string" && Array.isArray(questions) && questions.length > 0 && questions.every((q) => typeof q === "string")
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

const file = (dir: string, key: string, kind: "waiting" | "answer" | "delivered") => join(dir, `${key}.${kind}`);
const contentOf = (answer: Pick<AskAnswer, "answers" | "annotations">) => JSON.stringify({ answers: answer.answers, annotations: answer.annotations });
const read = (path: string) => readFile(path, "utf8").catch(() => null);

/** Whether the process lives, which a pid this user may not signal does too. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Waits, as `nexus-claude-hook ask` does, for the ask's answer, and answers it once it is written, or null to leave
 * the dialog to the terminal: once the waiting file no longer names `pid`, as after PostToolUse removed it when the
 * terminal answered, or once `claude` says Claude is gone. An answer or delivery left by an earlier ask of the same
 * questions in the session is removed first, so neither passes for this one's.
 */
export async function awaitAnswer(
  dir: string, key: string, pid: number, claude: () => boolean,
  { sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 500)) }: { sleep?: () => Promise<void> } = {},
): Promise<Pick<AskAnswer, "answers" | "annotations"> | null> {
  await mkdir(dir, { recursive: true });
  await rm(file(dir, key, "answer"), { force: true });
  await rm(file(dir, key, "delivered"), { force: true });
  const waiting = file(dir, key, "waiting");
  await writeFile(`${waiting}.${pid}`, String(pid));
  await rename(`${waiting}.${pid}`, waiting);
  for (;;) {
    if (await read(waiting) !== String(pid)) return null;
    if (!claude()) {
      await rm(waiting, { force: true });
      return null;
    }
    const answer = await read(file(dir, key, "answer"));
    if (answer !== null) {
      await rename(file(dir, key, "answer"), file(dir, key, "delivered"));
      await rm(waiting, { force: true });
      return JSON.parse(answer) as Pick<AskAnswer, "answers" | "annotations">;
    }
    await sleep();
  }
}

/**
 * Hands the answer to the hook that waits for its ask, as `nexus-claude-hook answer` does, and answers the exit code.
 * The answer file is created whole and only once, so of two different answers one is refused, while the same answer
 * again, before or after the hook took it, succeeds.
 */
export async function deliverAnswer(dir: string, answer: AskAnswer): Promise<number> {
  const key = askKey(answer.session, answer.questions);
  const content = contentOf(answer);
  if (await read(file(dir, key, "delivered")) === content) return answerExits.delivered;
  const waiter = await read(file(dir, key, "waiting"));
  if (waiter === null || !alive(Number(waiter))) return answerExits.nobodyWaits;
  const temp = `${file(dir, key, "answer")}.${process.pid}`;
  await writeFile(temp, content);
  try {
    await link(temp, file(dir, key, "answer"));
    return answerExits.delivered;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const there = await read(file(dir, key, "answer")) ?? await read(file(dir, key, "delivered"));
    return there === content ? answerExits.delivered : answerExits.answeredOtherwise;
  } finally {
    await rm(temp, { force: true });
  }
}

/** Ends the wait of the ask Claude has an answer to, as its PostToolUse does, so a hook whose dialog the terminal answered stops. */
export async function forgetAsk(dir: string, session: string, input: unknown): Promise<void> {
  const texts = askedTexts(input);
  if (texts !== null) await rm(file(dir, askKey(session, texts), "waiting"), { force: true });
}
