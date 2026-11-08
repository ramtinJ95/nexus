import { feature, type Features } from "../features.ts";
import type { TailnetNodeId } from "../../ids.ts";
import { HttpError } from "../http-error.ts";
import { answerDelivered, answerExits, claudeHook } from "../../../images/pylon/nexus-contract.ts";
import { askAnswer, choicesSchema, choicesSummary, type AnswerRefusal, type Choice, type ClaudeQuestion, type Question, type QuestionKind, type QuestionOf } from "../questions.ts";
import { ok, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { refusalOf } from "./access.ts";
import { questionRoutes as routes } from "../../contract/reviews.ts";
import { answerSchema } from "../../contract/reviews-parse.ts";
import type { z } from "zod";

const answeredConflict = (q: Question) => new HttpError(409, `question ${q.id} was answered ${JSON.stringify(q.answer!.option)} by ${q.answer!.by}`);
const answerRefusals: Record<AnswerRefusal, string> = {
  "not a person": "only a person's device may, never infrastructure nodes or pylons",
  "not a deployer": "its answer may deploy, so only deployers may",
};

type Body = z.output<typeof answerSchema>;
/** How a question of each kind takes the caller's answer, and what follows it. */
type Answering = { [K in QuestionKind]: (question: QuestionOf<K>, body: Body, caller: TailnetNodeId) => Question | Promise<Question> };

function optionOf(question: Question, body: Body): string {
  if (!("option" in body)) throw new HttpError(400, `question ${question.id} is answered with {"option": "<one of its options>"}`);
  if (!question.options.includes(body.option)) throw new HttpError(400, `${JSON.stringify(body.option)} is not an option of question ${question.id}, which are ${question.options.map((o) => JSON.stringify(o)).join(", ")}`);
  return body.option;
}

function answeredWith<Q extends Question>(answered: Q, option: string): Q {
  if (answered.answer!.option !== option) throw answeredConflict(answered);
  return answered;
}

export function questionRoutes(kit: ApiKit, features: Features): readonly RouteEntry[] {
  const { execInPylon, registry, claude } = kit;

  /**
   * Hands the person's choices to the Claude worker's AskUserQuestion dialog through the hook that waits in its pylon,
   * then records them, so a recorded answer is one Claude has. The hook takes one answer per ask, and the same one
   * again, so a retry after a lost reply is safe. When nobody waits any more, as after the terminal answered or the
   * turn ended, the question is withdrawn.
   */
  async function answerAsk(question: ClaudeQuestion, choices: Choice[], caller: TailnetNodeId): Promise<Question> {
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
    const answered = registry.answerQuestion(question, { option: choicesSummary(question.ask, choices), by: caller, at: Date.now(), choices });
    if (!same(answered)) throw answeredConflict(answered);
    return answered;
  }

  const record = <Q extends Question>(question: Q, option: string, caller: TailnetNodeId, then?: (answered: Q) => void) =>
    answeredWith(registry.answerQuestion(question, { option, by: caller, at: Date.now() }, then), option);
  const answering: Answering = {
    ask: (question, body, caller) => {
      if (!("choices" in body)) throw new HttpError(400, `question ${question.id} is a Claude worker's AskUserQuestion, answered with {"choices": [...]}, a choice for each question it asks`);
      return answerAsk(question, parse(choicesSchema(question.ask), body.choices), caller);
    },
    holds: (question, body, caller) => {
      const option = optionOf(question, body);
      return answeredWith(feature(features, "reviews").answerHolds(question, option, caller), option);
    },
    proposal: async (question, body, caller) => {
      const answered = record(question, optionOf(question, body), caller, features.planning?.answered);
      await features.pipeline?.poll();
      return answered;
    },
    judgment: (question, body, caller) => record(question, optionOf(question, body), caller),
    cleanup: (question, body, caller) => {
      const answered = record(question, optionOf(question, body), caller);
      // The deletes take as long as the node's disk does, so the answer does not wait for them.
      void features.cleanup?.poll();
      return answered;
    },
  };

  return [
    on(routes.answer, { role: "allowed", why: "each question says who may answer it, which refusalOf checks" }, async ({ question: id }, r) => {
      const body = parse(answerSchema, await r.body());
      const question = registry.question(id);
      if (question === null) throw new HttpError(404, `no question ${id}`);
      if (question.withdrawn !== undefined) throw new HttpError(409, `question ${question.id} was withdrawn when its thread was archived`);
      const refused = refusalOf(r.roles, question);
      if (refused !== null) throw new HttpError(403, `caller may not answer this question: ${answerRefusals[refused]}`);
      const answer = answering[question.kind] as (question: Question, body: Body, caller: TailnetNodeId) => Question | Promise<Question>;
      return ok(await answer(question, body, r.caller));
    }),
  ];
}
