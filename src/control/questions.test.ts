import { test } from "node:test";
import assert from "node:assert/strict";
import { textLimits, type ClaudeEntry } from "../claude-transcript.ts";
import { askAnswer, askedIn, askRecord, choicesSchema, choicesSummary, reportedAsks, type ClaudeAsk } from "./questions.ts";
import type { ThreadId } from "./registry.ts";

const drink = { question: "Which drink?", header: "Drink", multiSelect: false, options: [{ label: "Tea", description: "Hot", preview: "a cup of tea" }, { label: "Coffee", description: "Strong" }] };
const extras = { question: "What goes in it?", header: "Extras", multiSelect: true, options: [{ label: "Milk", description: "" }, { label: "Sugar", description: "" }, { label: "Honey", description: "" }] };
const call = (input: Record<string, unknown>, name = "AskUserQuestion"): ClaudeEntry => ({ kind: "tool", at: 5, id: "toolu_1", name, input });
const ask: ClaudeAsk = { session: "s1", toolUseId: "toolu_1", questions: [drink, extras] };

test("an AskUserQuestion call in the transcript gives its questions, and any other call, or input Claude's answer could not be keyed by, gives none", () => {
  assert.deepEqual(askedIn(call({ questions: [drink, { ...extras, extra: true }] })), [drink, extras]);
  const { multiSelect: _, ...single } = drink;
  assert.deepEqual(askedIn(call({ questions: [single] })), [drink], "a question without multiSelect is single-select");
  assert.equal(askedIn(call({ questions: [drink] }, "Bash")), null);
  assert.equal(askedIn({ kind: "reply", at: 5, text: "Which drink?" }), null);
  const cut = `${"x".repeat(textLimits.input - 1)}…`;
  for (const [why, input] of Object.entries({
    "no questions": { questions: [] },
    "an option that is not one": { questions: [{ ...drink, options: [{ label: 1, description: "" }] }] },
    "an option twice": { questions: [{ ...drink, options: [drink.options[0], drink.options[0]] }] },
    "a question twice": { questions: [drink, drink] },
    "a question the transcript cut": { questions: [{ ...drink, question: cut }] },
    "a label the transcript cut": { questions: [{ ...drink, options: [{ label: cut, description: "" }] }] },
  })) assert.equal(askedIn(call(input)), null, why);
  assert.deepEqual(askedIn(call({ questions: [{ ...drink, options: [{ ...drink.options[0], preview: cut }] }] }))?.[0]?.options[0]?.preview, cut, "a cut preview still shows");
});

test("the asks a pylon reports waiting are each one Claude's answer can key, none from an image that prints nothing, and output that is not a list fails", () => {
  const reported = { session: "s1", toolUseId: "toolu_1", at: 5, input: { questions: [drink, extras] } };
  assert.deepEqual(reportedAsks(`${JSON.stringify([reported])}\n`), [{ ask, at: 5 }]);
  assert.deepEqual(reportedAsks(""), [], "an image from before the subcommand");
  const others = [{ ...reported, input: { questions: [drink, drink] } }, { ...reported, toolUseId: "" }, { ...reported, session: 7 }, { ...reported, at: -1 }, "toolu_1"];
  assert.deepEqual(reportedAsks(JSON.stringify([...others, reported])), [{ ask, at: 5 }], "an input Claude's answer cannot key, and what is not an ask, ask nothing");
  for (const output of ["{", JSON.stringify({ asks: [reported] })]) assert.throws(() => reportedAsks(output), output);
});

test("an ask's question is named by its call, with a line per asked question, and is answered through choices", () => {
  assert.deepEqual(askRecord("th-1" as ThreadId, ask, 5), {
    id: "ask-toolu_1", thread: "th-1", text: "Drink: Which drink?\nExtras: What goes in it?", options: [], reserved: null, answerer: "person", askedAt: 5, ask,
  });
});

test("the person's choices take an answer per question, picked from its options or their own, one for a single-select question", () => {
  const schema = choicesSchema(ask);
  assert.deepEqual(schema.parse([{ picked: ["Tea"], notes: "  no rush " }, { picked: ["Honey", "Milk"], own: " Oat cream" }]), [
    { picked: ["Tea"], notes: "no rush" }, { picked: ["Milk", "Honey"], own: "Oat cream" },
  ], "picked in the order the question lists them, and the person's text trimmed");
  assert.deepEqual(schema.parse([{ picked: [], own: "Water" }, { picked: [], own: "Lemon" }]), [{ picked: [], own: "Water" }, { picked: [], own: "Lemon" }]);
  for (const [why, choices] of Object.entries({
    "a choice short": [{ picked: ["Tea"] }],
    "an option the question does not have": [{ picked: ["Juice"] }, { picked: ["Milk"] }],
    "an option twice": [{ picked: ["Tea"] }, { picked: ["Milk", "Milk"] }],
    "nothing picked and nothing of their own": [{ picked: [] }, { picked: ["Milk"] }],
    "an empty answer of their own": [{ picked: [], own: "   " }, { picked: ["Milk"] }],
    "an option and their own on a single-select question": [{ picked: ["Tea"], own: "Water" }, { picked: ["Milk"] }],
    "two options on a single-select question": [{ picked: ["Tea", "Coffee"] }, { picked: ["Milk"] }],
    "another field": [{ picked: ["Tea"], by: "nLAPTOP" }, { picked: ["Milk"] }],
  })) assert.equal(schema.safeParse(choices).success, false, why);
});

test("Claude gets each answer, for the call that asked, as the picked labels and the person's own joined as its terminal joins them, notes as annotations, and the summary says all in one line", () => {
  const choices = [{ picked: ["Tea"], notes: "no rush" }, { picked: ["Milk"], own: "Oat cream" }];
  assert.deepEqual(askAnswer(ask, choices), {
    session: "s1", questions: ["Which drink?", "What goes in it?"], toolUseId: "toolu_1",
    answers: { "Which drink?": "Tea", "What goes in it?": "Milk, Oat cream" },
    annotations: { "Which drink?": { notes: "no rush" } },
  });
  assert.equal(choicesSummary(ask, choices), "Drink: Tea; Extras: Milk, Oat cream");
});
