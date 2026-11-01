// The keyboard. In the inbox, j and k move through what waits, Enter opens the picked card's thread, e archives that
// thread and o opens the card's details. On a thread's page e archives the thread and goes back to the inbox, and u
// goes back without it. / filters the threads and ? lists the keys, on every page.
import { api } from "./request.js";
import { afterSwap, el, refreshAfter, showError } from "./page.js";
import { setOpen } from "./nav.js";

const typing = (target) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable === true;
const inbox = document.getElementById("needs-you");
const items = () => [...(inbox?.querySelectorAll(".need, .reply") ?? [])];
const current = () => inbox?.querySelector(".picked") ?? null;

// The card picked last and its place, so a poll's swap keeps it, or picks the card that took its place.
let picked = { id: null, index: -1 };
function pick(item) {
  for (const p of inbox.querySelectorAll(".picked")) p.classList.remove("picked");
  const list = items();
  picked = { id: item?.id ?? null, index: item === null ? -1 : list.indexOf(item) };
  if (item === null) return;
  item.classList.add("picked");
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "nearest" });
}
if (inbox !== null) {
  afterSwap(() => {
    if (picked.id === null) return;
    const list = items();
    const again = document.getElementById(picked.id) ?? list[Math.min(picked.index, list.length - 1)] ?? null;
    if (again === null) return void (picked = { id: null, index: -1 });
    again.classList.add("picked");
    picked = { id: again.id, index: list.indexOf(again) };
    if (document.activeElement === document.body) again.focus({ preventScroll: true });
  });
  // A click on a card picks it, so the keys go on from there.
  inbox.addEventListener("click", (event) => {
    const item = event.target instanceof Element ? event.target.closest(".need, .reply") : null;
    if (item !== null && !item.classList.contains("picked")) {
      for (const p of inbox.querySelectorAll(".picked")) p.classList.remove("picked");
      item.classList.add("picked");
      picked = { id: item.id, index: items().indexOf(item) };
    }
  });
}

const openOf = (item) => item.querySelector("a.need-thread, a.reply-thread")?.getAttribute("href") ?? null;

async function archive(item) {
  const thread = item.dataset.thread;
  if (thread === undefined) return void say(item, "A node's cleanup has no thread to archive. Answer Delete or Keep.");
  item.classList.add("leaving");
  try {
    await api("POST", `/v1/threads/${thread}/archive`);
    showError("action-error", null);
    await refreshAfter();
  } catch (err) {
    item.classList.remove("leaving");
    showError("action-error", err);
  }
}

const status = el("p", { className: "keys-say", role: "status" });
document.body.append(status);
let hush = 0;
function say(item, text) {
  status.textContent = text;
  clearTimeout(hush);
  hush = setTimeout(() => { status.textContent = ""; }, 3000);
  item?.focus({ preventScroll: true });
}

const keyList = [
  ["j / k", "Next and previous in the inbox"],
  ["Enter", "Open the picked card's thread"],
  ["e", "Archive the picked thread, or this thread on its page"],
  ["o", "Show or hide the picked card's details"],
  ["u", "Back to the inbox"],
  ["/", "Filter the threads"],
  ["n", "Start a thread"],
  ["⌘ Enter", "Send, start or add, in a form"],
  ["?", "These keys"],
];
let help = null;
function showKeys() {
  help ??= document.body.appendChild(el("dialog", { className: "modal keys-modal", ariaLabel: "Keyboard shortcuts" },
    el("header", {}, el("h2", { textContent: "Keyboard" }), el("button", { type: "button", className: "icon-btn", textContent: "✕", ariaLabel: "Close", onclick: () => help.close() })),
    el("dl", { className: "keys-list" }, ...keyList.flatMap(([key, what]) => [el("dt", {}, el("kbd", { textContent: key })), el("dd", { textContent: what })]))));
  help.showModal();
}

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || document.querySelector("dialog[open]") !== null) return;
  const onItem = event.target instanceof Element && event.target.matches(".need, .reply");
  const key = event.key;
  if (key === "?") {
    event.preventDefault();
    showKeys();
    return;
  }
  if (key === "/") {
    event.preventDefault();
    if (matchMedia("(max-width: 760px)").matches) setOpen("side");
    document.getElementById("filter")?.focus();
    return;
  }
  if (inbox === null) {
    const archiveButton = document.getElementById("archive");
    if (key === "u") location.assign("/");
    else if (key === "e" && archiveButton !== null && !archiveButton.disabled) {
      event.preventDefault();
      archiveButton.disabled = true;
      api("POST", `/v1/threads/${archiveButton.dataset.thread}/archive`).then(() => location.assign("/"), (err) => {
        archiveButton.disabled = false;
        showError("action-error", err);
      });
    }
    return;
  }
  // Keys on a card's own buttons and links keep their own meaning.
  if (!onItem && event.target !== document.body && key !== "j" && key !== "k") return;
  const list = items();
  const at = current();
  if (key === "j" || key === "k" || key === "ArrowDown" && onItem || key === "ArrowUp" && onItem) {
    if (list.length === 0) return;
    event.preventDefault();
    const index = at === null ? (key === "j" || key === "ArrowDown" ? 0 : list.length - 1) : list.indexOf(at) + (key === "j" || key === "ArrowDown" ? 1 : -1);
    pick(list[Math.max(0, Math.min(list.length - 1, index))]);
  } else if (at === null) {
    return;
  } else if (key === "Enter") {
    const href = openOf(at);
    if (href !== null) { event.preventDefault(); location.assign(href); }
  } else if (key === "e") {
    event.preventDefault();
    void archive(at);
  } else if (key === "o") {
    const summary = at.querySelector("details > summary");
    if (summary === null) say(at, "This card shows all it has.");
    else { event.preventDefault(); summary.click(); }
  } else if (key === "Escape") {
    pick(null);
  }
});
