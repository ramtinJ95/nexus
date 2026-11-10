// The thread's composer, which sends a message and keeps its draft per thread, and the forms that answer an ask.
import { request } from "./request.js";
import { answerFinal } from "../plain-wording.ts";
import { threadRoutes } from "../../contract/threads.ts";
import { questionRoutes } from "../../contract/reviews.ts";
import { chunk, end, notify, onSwap, refreshAfter, whenRunning } from "./page.js";
import { composerHolds, review, reviewSent } from "./review-notes.js";
import { kept } from "./contract.ts";
import { composerDraft } from "./draft.js";

const draft = composerDraft({ kept });
/**
 * Fills the composer with its draft, which is then what it holds of the review kept. A page with no composer, as an
 * archived thread's, leaves the review as kept, for the composer an unarchive brings back.
 */
function restore() {
  draft.restore();
  const prompt = document.getElementById("prompt-text");
  if (prompt !== null) composerHolds(prompt.value);
}
restore();
document.addEventListener("input", (event) => {
  if (event.target.id === "prompt-text") draft.save(event.target);
});

// crypto.randomUUID needs a secure context, and the dashboard is plain HTTP on the tailnet.
const newRequestId = () => `msg:${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

function showStatus(text) {
  const el = document.getElementById("action-status");
  if (el === null) return;
  el.textContent = text ?? "";
  el.hidden = text === null;
}

// The last message sent. Sending the same text again after a failure reuses its request ID, so a send whose
// reply was lost is not posted twice. One send at a time, so a second one cannot take the first one's ID.
let outgoing = null;
document.addEventListener("submit", (event) => {
  if (!event.target.matches("#prompt")) return;
  event.preventDefault();
  if (outgoing?.inFlight) return;
  const text = event.target.elements.text.value;
  // The button pressed, or the one its shortcut stands for, says whether the message steers the run or follows it.
  const mode = event.submitter?.value ?? "followUp";
  return send(event.target, { text, mode, requestId: outgoing?.text === text ? outgoing.requestId : newRequestId() });
});

async function send(form, message) {
  const thread = form.dataset.thread;
  const { text, requestId } = message;
  // The notes as they are now, so an edit saved while the send is out is not taken as sent.
  const composed = { composed: review.composed, notes: review.notes.filter((n) => review.composed?.ids.includes(n.id)) };
  outgoing = { text, requestId, inFlight: true };
  for (const button of form.querySelectorAll("button[type=submit]")) button.disabled = true;
  const post = () => request(threadRoutes.message, { thread, body: message });
  try {
    const terminalOnly = form.dataset.claude === undefined || !text.trimStart().startsWith("/") ? null : (await chunk(import("./slash.js"))).terminalOnlyReason(text, thread);
    if (terminalOnly !== null) {
      outgoing = null;
      return notify(new Error(terminalOnly));
    }
    // A Claude worker's message is typed in its pylon, so it waits for a paused pylon to wake, under the same request
    // ID, which the API types once however often it is asked.
    await (form.dataset.claude === undefined ? post() : whenRunning(thread, post, (err, detail) => {
      showStatus(detail.pylon.actualState === "running" ? `Not sent yet, trying again: ${err.message}` : "Waking the pylon. The message sends once Claude runs.");
    }));
    showStatus(null);
    outgoing = null;
    reviewSent(composed, text);
    draft.sent(thread, text);
    notify(null);
    await refreshAfter();
    end?.toEnd();
  } catch (err) {
    showStatus(null);
    outgoing.inFlight = false;
    // A Claude worker's send that failed partway may have typed the message, so the API refuses its request ID again.
    // The reader checks the conversation, and sending again is a new message. A 503 may still be typed, and its
    // reason says so: sending the same text again keeps the request ID, which answers what became of it.
    if (err.status === 422) outgoing = null;
    // A send that timed out may have reached the agent. Try again sends the same message under the same request ID,
    // whatever the draft holds now, so it goes at most once. A thread that takes no messages any more refuses it.
    if (err.timedOut) notify(new Error(`The message may not have been sent: ${err.message}.`), () => {
      if (!outgoing?.inFlight) void send(document.getElementById("prompt") ?? form, message);
    });
    else notify(err.status === 422 || err.status === 503 ? err : new Error(`The message was not sent: ${err.message}`));
  } finally {
    for (const button of document.querySelectorAll("#prompt button[type=submit]")) button.disabled = false;
  }
}

// A swap keeps the prompt box, so only a box that was not there before, as on unarchiving, takes the draft.
onSwap(() => {
  const before = document.getElementById("prompt-text");
  return () => {
    if (document.getElementById("prompt-text") !== before) restore();
    for (const send of document.querySelectorAll("#prompt button[type=submit]")) send.disabled = outgoing?.inFlight === true;
  };
});

/**
 * An AskUserQuestion form's choices, one per question as the answer route takes them: the options picked and the
 * person's own answer, which on a single-select question counts only while its radio is picked, and the notes.
 */
function askChoices(form) {
  return [...form.querySelectorAll("fieldset.ask-q")].map((question, i) => {
    const picked = [...question.querySelectorAll(`input[name="picked-${i}"]:checked`)].map((input) => input.value);
    const own = form.elements[`own-${i}`].value.trim();
    const notes = form.elements[`notes-${i}`].value.trim();
    const ownCounts = own !== "" && (question.dataset.multi === "true" || picked.includes(""));
    return { picked: picked.filter((label) => label !== ""), ...(ownCounts ? { own } : {}), ...(notes === "" ? {} : { notes }) };
  });
}

// Typing an answer of one's own on a single-select question picks it.
document.addEventListener("input", (event) => {
  const own = event.target instanceof Element ? event.target.closest(".ask-own input[type=text]") : null;
  const radio = own?.parentElement.querySelector("input[type=radio]");
  if (radio != null && own.value.trim() !== "") radio.checked = true;
});

document.addEventListener("submit", async (event) => {
  if (!event.target.matches("form.ask")) return;
  event.preventDefault();
  const form = event.target;
  const choices = askChoices(form);
  const headers = [...form.querySelectorAll("fieldset.ask-q")].map((q) => q.dataset.header);
  const missing = choices.findIndex((c) => c.picked.length === 0 && c.own === undefined);
  if (missing !== -1) return void notify(new Error(`Answer "${headers[missing]}" first: pick an option or write your own answer.`));
  const summary = choices.map((c, i) => `${headers[i]}: ${[...c.picked, ...(c.own === undefined ? [] : [c.own])].join(", ")}`).join("; ");
  if (!confirm(`Answer Claude "${summary}"? ${answerFinal}`)) return;
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    await request(questionRoutes.answer, { question: form.dataset.question, body: { choices } });
    notify(null);
    await refreshAfter();
  } catch (err) {
    notify(err);
    submit.disabled = false;
    // An ask nobody waits for any more is withdrawn, so the page drops its form.
    if (err.status === 409) await refreshAfter();
  }
});
