// The start and new-project dialogs, which start a thread and add a project, and the page's keyboard shortcuts.
import { startHint } from "./start-hint.ts";
import { titleOf } from "../../thread-title.ts";
import { api } from "./request.js";
import { onSwap, refreshAfter, showError } from "./page.js";
import { setOpen } from "./nav.js";
import { startForm } from "./start-form.js";

export const dialog = document.getElementById("start-dialog");
export const projectDialog = document.getElementById("project-dialog");

function updateStartHint() {
  const form = document.getElementById("start");
  const project = form?.querySelector("input[name=project]:checked");
  if (form === null || project === null || project === undefined) return;
  const node = form.elements.node.value || project.dataset.node;
  const branch = form.elements.branch.value || project.dataset.branch;
  form.querySelector("#start-node option[value='']").textContent = `${project.dataset.node} (project default)`;
  form.elements.branch.placeholder = project.dataset.branch;
  form.elements.cpus.placeholder = project.dataset.cpus;
  form.elements.memoryGiB.placeholder = project.dataset.memoryGib;
  form.elements.diskGiB.placeholder = project.dataset.diskGib;
  const hint = document.getElementById("start-hint");
  const parts = startHint({ node, image: hint.dataset.image || null, branch, scratch: project.dataset.scratch !== undefined });
  hint.replaceChildren(...parts.map(({ text, look }) => look === undefined ? text : Object.assign(document.createElement(look), { textContent: text })));
}

/**
 * Shows the fields of the worker picked and disables the others', so the form sends none of them. A Claude worker's
 * title is optional, as it defaults to the prompt's first line.
 */
function syncWorker(form) {
  const claude = form.elements.worker.value === "claude";
  form.querySelector("#start-claude-fields").hidden = !claude;
  form.querySelector("#start-harness-fields").hidden = claude;
  form.elements.claude.disabled = !claude;
  form.elements.model.disabled = !claude;
  form.elements.planning.disabled = claude;
  form.elements.title.required = !claude;
  form.elements.title.placeholder = claude ? "The prompt's first line" : "What should this thread do?";
  form.querySelector("#start-title-label").textContent = claude ? "Title (optional)" : "Title";
}
document.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name === "worker" && event.target.form?.matches("#start")) syncWorker(event.target.form);
});

const { projectRadios, selectProject, formDrafts, restoreDrafts, restoreStart } = startForm({ starting: () => starting, syncWorker, updateStartHint, showError });
onSwap((regions) => {
  const drafts = formDrafts(regions);
  return () => {
    restoreDrafts(drafts);
    restoreStart(drafts);
  };
});

export async function openStart(project, title) {
  if (dialog === null) return;
  setOpen(null);
  if (!dialog.open) dialog.showModal();
  if (project) {
    // The dialog's projects refresh with the page, so a project added since the last poll may be on its way.
    if (!projectRadios().some((r) => r.value === project)) await refreshAfter();
    selectProject(project);
  }
  const input = document.getElementById("start-title");
  if (title && input !== null) input.value = title;
  updateStartHint();
}
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("[data-start]") : null;
  if (link === null || dialog === null) return;
  event.preventDefault();
  void openStart(link.dataset.start, link.dataset.title);
});
dialog?.addEventListener("close", () => {
  if (location.pathname === "/threads/new") history.replaceState(null, "", "/");
});
document.addEventListener("input", (event) => {
  if (event.target instanceof Element && event.target.closest("#start") !== null) updateStartHint();
});

// ⌘↵ submits as well as the button, so a second press while the first is in flight must not start a second thread.
let starting = false;
document.addEventListener("submit", async (event) => {
  if (!event.target.matches("#start")) return;
  event.preventDefault();
  if (starting) return;
  starting = true;
  const form = event.target;
  // Empty optional fields mean the project's defaults, which the API applies when the field is absent. The size
  // fields go in `resources`, as the API takes them. The worker picked shows in which fields are sent.
  const { cpus, memoryGiB, diskGiB, ...body } = Object.fromEntries([...new FormData(form)].filter(([key, value]) => value !== "" && key !== "worker"));
  const resources = Object.fromEntries(Object.entries({ cpus, memoryGiB, diskGiB }).flatMap(([key, value]) => value === undefined ? [] : [[key, Number(value)]]));
  if (Object.keys(resources).length > 0) body.resources = resources;
  if (body.claude !== undefined && body.title === undefined) body.title = titleOf(body.claude);
  if (body.planning !== undefined) body.planning = true;
  form.querySelector("button[type=submit]").disabled = true;
  try {
    const thread = await api("POST", "/v1/threads", body);
    location.assign(`/threads/${thread.id}`);
  } catch (err) {
    starting = false;
    showError("start-error", err);
    const submit = document.querySelector("#start button[type=submit]");
    if (submit !== null) submit.disabled = false;
  }
});

export function openProject() {
  if (projectDialog === null) return;
  setOpen(null);
  // Offered from the start dialog when there is no project to start a thread on.
  if (dialog?.open) dialog.close();
  if (!projectDialog.open) projectDialog.showModal();
}
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("[data-new-project]") : null;
  if (link === null || projectDialog === null) return;
  event.preventDefault();
  openProject();
});
projectDialog?.addEventListener("close", () => {
  if (location.pathname === "/projects/new") history.replaceState(null, "", "/");
});

/** A scratch project has no URL to ask for, and its branch is the empty repository's first. */
function syncRepoKind(form) {
  const scratch = form.elements.repoKind.value === "scratch";
  const url = form.elements.repoUrl;
  url.disabled = scratch;
  url.hidden = scratch;
  form.querySelector("label[for=project-repo]").hidden = scratch;
  form.querySelector("label[for=project-branch]").textContent = scratch ? "Initial branch" : "Branch";
}
document.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name === "repoKind" && event.target.form?.matches("#project")) syncRepoKind(event.target.form);
});

// The project `nexus project add` sends: the dialog's fields, the resources the form names, and the GitHub grant
// when asked for. Once added, the start dialog opens on it, as the dashboard's next step for a project is its first thread.
let adding = false;
document.addEventListener("submit", async (event) => {
  // Not event.target.id: a form's field named "id" shadows its id.
  if (!event.target.matches("#project")) return;
  event.preventDefault();
  if (adding) return;
  adding = true;
  const form = event.target;
  const field = (name) => form.elements[name].value.trim();
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const project = await api("POST", "/v1/projects", {
      id: field("id"), repoUrl: form.elements.repoKind.value === "scratch" ? null : field("repoUrl"), defaultBranch: field("defaultBranch"), defaultNode: field("defaultNode"),
      resources: JSON.parse(form.dataset.resources), allowedHosts: [], secrets: form.elements.github.checked ? [JSON.parse(form.dataset.githubGrant)] : [],
      logins: [], preSetup: null,
    });
    form.reset();
    syncRepoKind(form);
    showError("project-error", null);
    projectDialog.close();
    await openStart(project.id);
  } catch (err) {
    showError("project-error", err);
  } finally {
    adding = false;
    submit.disabled = false;
  }
});

const typing = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el?.isContentEditable === true;
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    const form = event.target instanceof Element ? event.target.closest("#prompt, #start, #project") : null;
    if (form === null) return;
    event.preventDefault();
    form.requestSubmit(form.querySelector("#send"));
  } else if (event.key === "Enter" && event.altKey && event.target instanceof Element && event.target.closest("#prompt") !== null) {
    event.preventDefault();
    const queue = document.getElementById("queue");
    if (queue !== null) queue.form.requestSubmit(queue);
  } else if (event.key === "Escape" && document.body.dataset.open !== undefined) {
    setOpen(null);
  } else if (event.key === "n" && !event.metaKey && !event.ctrlKey && !event.altKey && !typing(event.target) && dialog !== null && document.querySelector("dialog[open]") === null) {
    // Browsers keep ⌘N for a new window, so the shortcut is the bare key.
    event.preventDefault();
    openStart(null);
  }
});
