// The thread's composer, which sends a message and keeps its draft across a swap, and the forms that answer an ask.
import { api } from "./request.js";
import { end, onSwap, refreshAfter, showError, whenRunning } from "./page.js";
import { review, reviewSent } from "./checkout.js";

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
document.addEventListener("submit", async (event) => {
  if (!event.target.matches("#prompt")) return;
  event.preventDefault();
  if (outgoing?.inFlight) return;
  const form = event.target;
  const thread = form.dataset.thread;
  const text = form.elements.text.value;
  // The notes as they are now, so an edit saved while the send is out is not taken as sent.
  const composed = { composed: review.composed, notes: review.notes.filter((n) => review.composed?.ids.includes(n.id)) };
  // The button pressed, or the one its shortcut stands for, says whether the message steers the run or follows it.
  const mode = event.submitter?.value ?? "followUp";
  if (outgoing?.text !== text) outgoing = { text, requestId: newRequestId() };
  outgoing.inFlight = true;
  for (const send of form.querySelectorAll("button[type=submit]")) send.disabled = true;
  const { requestId } = outgoing;
  const post = () => api("POST", `/v1/threads/${thread}/messages`, { text, requestId, mode });
  try {
    const terminalOnly = form.dataset.claude === undefined || !text.trimStart().startsWith("/") ? null : (await import("./slash.js")).terminalOnlyReason(text, thread);
    if (terminalOnly !== null) {
      outgoing = null;
      return showError("action-error", new Error(terminalOnly));
    }
    // A Claude worker's message is typed in its pylon, so it waits for a paused pylon to wake, under the same request
    // ID, which the API types once however often it is asked.
    await (form.dataset.claude === undefined ? post() : whenRunning(thread, post, (err, detail) => {
      showStatus(detail.pylon.actualState === "running" ? `Not sent yet, trying again: ${err.message}` : "Waking the pylon. The message sends once Claude runs.");
    }));
    showStatus(null);
    outgoing = null;
    reviewSent(composed, text);
    // The poll may have swapped in a new prompt box meanwhile, or none if the thread was archived. Text typed
    // since the send is the next message, so it stays.
    const prompt = document.getElementById("prompt-text");
    if (prompt?.value === text) prompt.value = "";
    showError("action-error", null);
    await refreshAfter();
    end?.toEnd();
  } catch (err) {
    showStatus(null);
    outgoing.inFlight = false;
    // A Claude worker's send that failed partway may have typed the message, so the API refuses its request ID again.
    // The reader checks the conversation, and sending again is a new message. A 503 may still be typed, and its
    // reason says so: sending the same text again keeps the request ID, which answers what became of it.
    if (err.status === 422) outgoing = null;
    showError("action-error", err.status === 422 || err.status === 503 ? err : new Error(`The message was not sent: ${err.message}`));
  } finally {
    for (const send of document.querySelectorAll("#prompt button[type=submit]")) send.disabled = false;
  }
});

onSwap(() => {
  const draft = document.getElementById("prompt-text");
  const saved = draft === null ? null : { value: draft.value, start: draft.selectionStart, end: draft.selectionEnd };
  return () => {
    const prompt = document.getElementById("prompt-text");
    if (saved !== null && prompt !== null && prompt !== draft) {
      prompt.value = saved.value;
      prompt.setSelectionRange(saved.start, saved.end);
    }
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
  if (missing !== -1) return void showError("action-error", new Error(`Answer "${headers[missing]}" first: pick an option or write your own answer.`));
  const summary = choices.map((c, i) => `${headers[i]}: ${[...c.picked, ...(c.own === undefined ? [] : [c.own])].join(", ")}`).join("; ");
  if (!confirm(`Answer Claude "${summary}"? The answer cannot be changed.`)) return;
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    await api("POST", `/v1/questions/${encodeURIComponent(form.dataset.question)}/answer`, { choices });
    showError("action-error", null);
    await refreshAfter();
  } catch (err) {
    showError("action-error", err);
    submit.disabled = false;
    // An ask nobody waits for any more is withdrawn, so the page drops its form.
    if (err.status === 409) await refreshAfter();
  }
});
