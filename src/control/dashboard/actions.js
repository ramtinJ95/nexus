// The buttons that act on a thread, an item or a question, each as the CLI's command does.
import { request } from "./request.js";
import { pylonRoutes } from "../../contract/pylon.ts";
import { threadRoutes } from "../../contract/threads.ts";
import { itemRoutes, projectRoutes } from "../../contract/projects.ts";
import { questionRoutes, reviewRoutes } from "../../contract/reviews.ts";
import { refreshAfter, showError, whenRunning } from "./page.js";
import { setOpen } from "./nav.js";
import { showSession } from "./checkout.js";

const actions = {
  archive: (thread) => request(threadRoutes.archive, { thread }),
  unarchive: (thread) => request(threadRoutes.unarchive, { thread }),
  // A started thread's page has a conversation and an inspector, which the queued page has no regions for.
  "start-queued": async (thread) => {
    await request(threadRoutes.startQueued, { thread });
    location.assign(`/threads/${thread}`);
  },
  delete: (thread) => request(threadRoutes.delete, { thread }),
  abort: (thread) => request(threadRoutes.abort, { thread }),
  retry: (thread) => request(threadRoutes.retry, { thread }),
  "retry-pylon": (thread) => request(threadRoutes.retryPylon, { thread }),
  // Publishes the port. The next refresh shows its preview, which links once the node serves it.
  "link-port": (thread, { port }) => request(pylonRoutes.preview, { thread, body: { port: Number(port) } }),
  // As `nexus unpreview`.
  unpublish: (thread, { port }) => whenRunning(thread, () => request(pylonRoutes.unpreview, { thread, port })),
  // As `nexus review --cancel`.
  "cancel-review": (thread) => request(reviewRoutes.cancel, { thread }),
  // As `nexus land`, for the commit the confirmation named, waiving the holds the card names the person may waive. The
  // page then shows the landing's steps as the review moves through them.
  land: (thread, { head, holds }) => request(reviewRoutes.land, { thread, body: holds === undefined ? { head } : { head, waive: JSON.parse(holds) } }),
  // As `nexus review --pr <pr>`, with --land when the project lands its reviews.
  "review-again": (thread, { pr, land }) => request(reviewRoutes.start, { thread, body: { pr: Number(pr), land: land === "true" } }),
  "approve-item": (_, { item }) => request(itemRoutes.approve, { item }),
  "cancel-item": (_, { item }) => request(itemRoutes.cancel, { item }),
  // As `nexus project edit --auto-review`.
  "auto-review": (_, { project, mode }) => request(projectRoutes.edit, { project, body: { autoReview: mode === "off" ? null : { mode } } }),
  answer: (_, { question, option }) => request(questionRoutes.answer, { question, body: { option } }),
  // As `nexus session open`, then shows the session in the terminal.
  "open-session": async (thread, { harness }) => {
    const { herdrPane } = await whenRunning(thread, () => request(pylonRoutes.openSession, { thread, body: { harness } }));
    await showSession(thread, herdrPane);
  },
  // As `nexus session close`.
  "close-session": (thread, { session }) => request(pylonRoutes.closeSession, { thread, session }),
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
