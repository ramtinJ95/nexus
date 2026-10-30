// The buttons that act on a thread, an item or a question, each as the CLI's command does.
import { api } from "./request.js";
import { refreshAfter, showError, whenRunning } from "./page.js";
import { setOpen } from "./nav.js";
import { showSession } from "./checkout.js";

const actions = {
  archive: (thread) => api("POST", `/v1/threads/${thread}/archive`),
  unarchive: (thread) => api("POST", `/v1/threads/${thread}/unarchive`),
  // A started thread's page has a conversation and an inspector, which the queued page has no regions for.
  "start-queued": async (thread) => {
    await api("POST", `/v1/threads/${thread}/start`);
    location.assign(`/threads/${thread}`);
  },
  delete: (thread) => api("DELETE", `/v1/threads/${thread}`),
  abort: (thread) => api("POST", `/v1/threads/${thread}/abort`),
  retry: (thread) => api("POST", `/v1/threads/${thread}/retry`),
  "retry-pylon": (thread) => api("POST", `/v1/threads/${thread}/pylon/retry`),
  // Publishes the port. The next refresh shows its preview, which links once the node serves it.
  "link-port": (thread, { port }) => api("POST", `/v1/threads/${thread}/previews`, { port: Number(port) }),
  // As `nexus unpreview`.
  unpublish: (thread, { port }) => whenRunning(thread, () => api("DELETE", `/v1/threads/${thread}/previews/${port}`, {})),
  // As `nexus review --cancel`.
  "cancel-review": (thread) => api("POST", `/v1/threads/${thread}/review/cancel`, {}),
  // As `nexus land`, for the commit the confirmation named, waiving the holds the card names the person may waive. The
  // page then shows the landing's steps as the review moves through them.
  land: (thread, { head, holds }) => api("POST", `/v1/threads/${thread}/land`, holds === undefined ? { head } : { head, waive: JSON.parse(holds) }),
  // As `nexus review --pr <pr>`, with --land when the project lands its reviews.
  "review-again": (thread, { pr, land }) => api("POST", `/v1/threads/${thread}/review`, { pr: Number(pr), land: land === "true" }),
  "approve-item": (_, { item }) => api("POST", `/v1/items/${encodeURIComponent(item)}/approve`, {}),
  "cancel-item": (_, { item }) => api("POST", `/v1/items/${encodeURIComponent(item)}/cancel`, {}),
  answer: (_, { question, option }) => api("POST", `/v1/questions/${encodeURIComponent(question)}/answer`, { option }),
  // As `nexus session open`, then shows the session in the terminal.
  "open-session": async (thread, { harness }) => {
    const { herdrPane } = await whenRunning(thread, () => api("POST", `/v1/threads/${thread}/sessions`, { harness }));
    await showSession(thread, herdrPane);
  },
  // As `nexus session close`.
  "close-session": (thread, { session }) => api("DELETE", `/v1/threads/${thread}/sessions/${encodeURIComponent(session)}`, {}),
  "show-session": (thread, { pane }) => showSession(thread, pane),
};

document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (button === null) return;
  const { action, thread } = button.dataset;
  if (button.dataset.confirm !== undefined && !confirm(button.dataset.confirm)) return;
  button.disabled = true;
  setOpen(null);
  try {
    await actions[action](thread, button.dataset);
    showError("action-error", null);
    await refreshAfter();
  } catch (err) {
    showError("action-error", err);
    button.disabled = false;
  }
});
