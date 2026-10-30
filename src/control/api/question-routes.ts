/**
 * Answering a thread's questions, a Claude worker's AskUserQuestion included.
 */
import { z } from "zod";
import type { Pipeline } from "../pipeline.ts";
import type { Planning } from "../planning.ts";
import type { TailnetNodeId } from "../../ids.ts";
import { HttpError } from "../http-error.ts";
import { answerDelivered, answerExits, claudeHook } from "../../../images/pylon/nexus-contract.ts";
import { askAnswer, choicesSchema, choicesSummary, type AnswerRefusal, type Choice, type ClaudeAsk, type Question } from "../questions.ts";
import { ok, parse, type RouteEntry, type ApiKit } from "./kit.ts";

/** An ask is answered with a choice per question it asks, and any other question with one of its options. */
const answerSchema = z.union([z.strictObject({ option: z.string() }), z.strictObject({ choices: z.array(z.unknown()) })]);
const answeredConflict = (q: Question) => new HttpError(409, `question ${q.id} was answered ${JSON.stringify(q.answer!.option)} by ${q.answer!.by}`);
const answerRefusals: Record<AnswerRefusal, string> = {
  "not a person": "only a person's device may, never infrastructure nodes or pylons",
  "not a deployer": "its answer may deploy, so only deployers may",
};

export function questionRoutes(kit: ApiKit, options: { planning?: Planning | null | undefined; pipeline?: Pipeline | null | undefined }): readonly RouteEntry[] {
  const { refusalOf, execInPylon, registry, claude } = kit;

  /**
   * Hands the person's choices to the Claude worker's AskUserQuestion dialog through the hook that waits in its pylon,
   * then records them, so a recorded answer is one Claude has. The hook takes one answer per ask, and the same one
   * again, so a retry after a lost reply is safe. When nobody waits any more, as after the terminal answered or the
   * turn ended, the question is withdrawn.
   */
  async function answerAsk(question: Question & { ask: ClaudeAsk }, choices: Choice[], caller: TailnetNodeId): Promise<Question> {
    const same = (q: Question) => JSON.stringify(q.answer?.choices) === JSON.stringify(choices);
    if (question.answer !== null) {
      if (same(question)) return question;
      throw answeredConflict(question);
    }
    const t = registry.thread(question.thread)!;
    const { exitCode, output } = await execInPylon(t, [claudeHook, "answer", JSON.stringify(askAnswer(question.ask, choices))]);
    void claude.refresh(t);
    if (exitCode === answerExits.nobodyWaits) {
      registry.withdrawAsk(question.id);
      throw new HttpError(409, "Claude no longer waits for this answer: it was answered in the terminal, its turn ended, or its pylon paused since. Send it to Claude as a message instead");
    }
    if (exitCode === answerExits.answeredOtherwise) {
      const now = registry.question(question.id);
      throw now?.answer != null ? answeredConflict(now) : new HttpError(409, `another answer to question ${question.id} reached Claude first`);
    }
    if (exitCode === 127 || (exitCode === answerExits.delivered && !new RegExp(`^${answerDelivered}$`, "m").test(output))) {
      throw new HttpError(409, `pylon ${t.pylonId} runs an image from before AskUserQuestion could be answered from the dashboard, so answer it in the pylon's terminal (\`nexus attach ${t.id}\`)`);
    }
    if (exitCode !== answerExits.delivered) {
      throw new HttpError(502, exitCode === null ? `the answer was not handed to Claude: nexus-claude-hook answer did not finish within 15 s in pylon ${t.pylonId}`
        : `the answer was not handed to Claude: nexus-claude-hook answer exited ${exitCode} in pylon ${t.pylonId}: ${output.trim().slice(0, 500)}`);
    }
    // A pull since the delivery, which finds the hook that took the answer gone, may have withdrawn the unanswered
    // question, and the answer is still its.
    const { answer: _, ...asked } = question;
    registry.askQuestion(asked);
    const answered = registry.answerQuestion(question.id, { option: choicesSummary(question.ask, choices), by: caller, at: Date.now(), choices });
    if (!same(answered)) throw answeredConflict(answered);
    return answered;
  }

  return [
    ["POST", /^\/v1\/questions\/([^/]+)\/answer$/, { open: "each question says who may answer it, which refusalOf checks" }, async ([, id], r) => {
      const body = parse(answerSchema, await r.body());
      const question = registry.question(id!);
      if (question === null) throw new HttpError(404, `no question ${id}`);
      const refused = refusalOf(r.caller, question);
      if (refused !== null) throw new HttpError(403, `caller may not answer this question: ${answerRefusals[refused]}`);
      if (question.ask !== undefined) {
        if (!("choices" in body)) throw new HttpError(400, `question ${question.id} is a Claude worker's AskUserQuestion, answered with {"choices": [...]}, a choice for each question it asks`);
        return ok(await answerAsk({ ...question, ask: question.ask }, parse(choicesSchema(question.ask), body.choices), r.caller));
      }
      if (!("option" in body)) throw new HttpError(400, `question ${question.id} is answered with {"option": "<one of its options>"}`);
      const { option } = body;
      if (!question.options.includes(option)) throw new HttpError(400, `${JSON.stringify(option)} is not an option of question ${question.id}, which are ${question.options.map((o) => JSON.stringify(o)).join(", ")}`);
      const answered = registry.answerQuestion(question.id, { option, by: r.caller, at: Date.now() }, options.planning?.answered);
      if (answered.answer!.option !== option) throw answeredConflict(answered);
      if (answered.proposal !== undefined) await options.pipeline?.poll();
      return ok(answered);
    }],
  ];
}
