// The buttons that act on a thread, an item or a question, each as the CLI's command does.
import { request } from "./request.js";
import { pylonRoutes } from "../../contract/pylon.ts";
import { threadRoutes } from "../../contract/threads.ts";
import { itemRoutes, projectRoutes } from "../../contract/projects.ts";
import { questionRoutes, reviewRoutes } from "../../contract/reviews.ts";
import { notify, refreshAfter, whenRunning } from "./page.js";
import { setOpen } from "./nav.js";
import { showSession } from "./terminal-tab.js";

/** How long a published port has to be served, and how often it is asked, as `nexus preview --wait` waits. */
const servedWithinMs = 120_000;
const askEveryMs = 1_000;

/**
 * Publishes a port, as `nexus preview --wait` does, and opens its preview once the node serves it. The tab opens
 * before the first await, while the browser still counts the click as the person's and lets it open, and its opener
 * is cut, as rel="noopener" cuts a link's. A browser that blocks the tab still gets the port published.
 */
export function publishOpening({ request, refresh, open, wait, now }) {
  return async (thread, { port }) => {
    const tab = open();
    if (tab !== null) tab.opener = null;
    try {
      await request(pylonRoutes.preview, { thread, body: { port: Number(port) } });
      if (tab === null) return;
      await refresh();
      const deadline = now() + servedWithinMs;
      let preview;
      while (true) {
        preview = (await request(threadRoutes.show, { thread })).ports?.find((l) => l.port === Number(port))?.preview;
        if (preview?.ready === true) {
          tab.location.href = preview.url;
          return;
        }
        if (now() >= deadline) break;
        await wait(askEveryMs);
      }
      throw new Error(`Port ${port} was not served within ${servedWithinMs / 1000} s${preview?.failed ? `, because ${preview.failed}` : ""}. Its preview opens from Previews once it is.`);
    } catch (err) {
      tab?.close();
      throw err;
    }
  };
}

/** What each `data-action` in contract.ts does. */
export const handlers = {
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
  "link-port": publishOpening({
    request, refresh: refreshAfter,
    open: () => window.open("about:blank", "_blank"),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  }),
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
    await handlers[action](thread, button.dataset);
    notify(null);
    await refreshAfter();
  } catch (err) {
    notify(err.timedOut ? new Error(`This may not have happened: ${err.message}. Press it again to try again.`) : err);
  } finally {
    // A swap replaced the button of an action that changed its region. One that changed none, such as Show in
    // terminal, is still in the page and takes another press.
    if (button.isConnected) button.disabled = false;
  }
});
