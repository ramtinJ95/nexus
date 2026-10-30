import { test } from "node:test";
import assert from "node:assert/strict";
import { startForm } from "./start-form.js";

test("a swap keeps what the reader filled in on each form it replaces, and the start dialog says a project no longer offered is gone", () => {
  const field = (name, type, value, checked = false, extra = {}) => ({ name, type, value, checked, ...extra });
  const form = (id, fields, question) => {
    const submit = { disabled: false };
    return { id, dataset: question === undefined ? {} : { question }, elements: fields, submit, querySelector: (selector) => selector === "button[type=submit]" ? submit : null };
  };
  const options = (...values) => ({ options: values.map((value) => ({ value })) });
  const start = (projects, nodes) => form("start", [
    field("worker", "radio", "claude", true), field("worker", "radio", "harness"), field("title", "text", ""), field("claude", "textarea", ""),
    field("node", "select-one", "", false, options("", "auto", ...nodes)), ...projects.map((p, i) => field("project", "radio", p, i === 0)),
  ]);
  const ask = () => form("", [field("picked-0", "radio", "A"), field("picked-0", "radio", "B"), field("own-0", "text", "")], "q1");
  const prompt = () => form("prompt", [field("text", "textarea", "")]);

  const before = [start(["acme", "beta"], ["tower"]), ask(), prompt()];
  const [oldStart, oldAsk, oldPrompt] = before;
  oldStart.elements[0].checked = false;
  oldStart.elements[1].checked = true;
  oldStart.elements[2].value = "Ship it";
  oldStart.elements[4].value = "tower";
  oldStart.elements[5].checked = false;
  oldStart.elements[6].checked = true;
  oldAsk.elements[0].checked = true;
  oldAsk.elements[2].value = "my own";
  oldPrompt.elements[0].value = "a draft the composer keeps itself";

  let forms = before;
  const errors = [];
  const synced = [];
  const document = {
    querySelectorAll: (selector) => selector === "form" ? forms : forms[0].elements.filter((f) => f.name === "project"),
    getElementById: (id) => forms.find((f) => f.id === id) ?? null,
  };
  const { formDrafts, restoreDrafts, restoreStart } = startForm({
    starting: () => true, syncWorker: (f) => synced.push(f), updateStartHint: () => {},
    showError: (_, err) => errors.push(err === null ? null : err.message),
  }, { document });
  const drafts = formDrafts([{ querySelectorAll: () => before }]);
  forms = [start(["acme"], []), ask(), prompt()];
  restoreDrafts(drafts);
  restoreStart(drafts);
  const [newStart, newAsk, newPrompt] = forms;
  const values = (f) => f.elements.map((e) => e.type === "radio" ? `${e.name}=${e.value}:${e.checked}` : `${e.name}=${e.value}`);
  assert.deepEqual(values(newStart), ["worker=claude:false", "worker=harness:true", "title=Ship it", "claude=", "node=", "project=acme:false"],
    "the typed title and picked worker are kept, the node whose option is gone is not, and no project is picked in place of the one gone");
  assert.deepEqual(errors, ["Project beta is not offered here yet. Reload the page to see it."]);
  assert.deepEqual(synced, [newStart], "the worker's fields follow the worker picked, once");
  assert.equal(newStart.submit.disabled, true, "a start in flight stays unsendable");
  assert.deepEqual(values(newAsk), ["picked-0=A:true", "picked-0=B:false", "own-0=my own"]);
  assert.deepEqual(values(newPrompt), ["text="], "the composer restores its own draft");
});
