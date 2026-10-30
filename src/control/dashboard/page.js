// The page core every dashboard page runs: its regions and the poll and stream that swap them, the folds the reader
// toggled, its visit, and the markup the features build. Features hook into a swap through `onSwap` and `afterSwap`.
import { agoText, clock } from "./elapsed.ts";
import { atEnd, endFollower } from "./scroll.js";
import { api } from "./request.js";

export const main = document.querySelector("main");
export const pollMs = Number(main?.dataset.pollMs);
export const scroller = document.getElementById("scroll");
export const end = scroller === null ? null : endFollower(scroller, (resized) => new ResizeObserver(resized).observe(scroller));

export function showError(id, err) {
  const el = document.getElementById(id);
  if (el === null) return;
  el.textContent = err === null ? "" : err.message;
  el.hidden = err === null;
}

const focusKey = (el) => el.id !== "" ? `#${CSS.escape(el.id)}`
  : el instanceof HTMLAnchorElement ? `a[href="${CSS.escape(el.getAttribute("href"))}"]`
  : null;

export function tick() {
  for (const time of document.querySelectorAll("time[data-since]")) time.textContent = clock(Date.now() - Number(time.dataset.since));
  for (const time of document.querySelectorAll("time[data-ago]")) time.textContent = agoText(Date.parse(time.dateTime), Date.now());
}

// What the server last sent for each region. Comparing against it rather than the live DOM means a tool the
// reader opened or the ticking run clock is not a change, so an unchanged region is never swapped.
const comparable = (html) => html.replace(/(<time data-since="\d+">)[^<]*/g, "$1");
const served = new Map([...document.querySelectorAll("[data-live]")].map((el) => [el.id, comparable(el.innerHTML)]));
// The folds the reader opened or closed. The rest follow the server, so a fold that opened for a running step
// closes once the step is done.
export const toggled = new Map();
// The projects the reader folded in the sidebar stay folded on every page.
const foldedKey = "nexus.folded";
const folded = new Set(JSON.parse(localStorage.getItem(foldedKey) ?? "[]"));
for (const id of folded) toggled.set(id, false);
document.addEventListener("click", (event) => {
  const details = event.target instanceof Element ? event.target.closest("summary")?.parentElement : null;
  if (!(details instanceof HTMLDetailsElement) || details.id === "") return;
  toggled.set(details.id, !details.open);
  if (!details.classList.contains("group")) return;
  if (details.open) folded.add(details.id);
  else folded.delete(details.id);
  localStorage.setItem(foldedKey, JSON.stringify([...folded]));
});

/**
 * The conversation only grows, so its n-th block is the same block after a swap. Keeping the first visible
 * block where it was holds the reader's place while a fold above it opens or closes.
 */
function anchor() {
  if (end === null) return () => {};
  if (end.following) return end.settle;
  const convo = document.getElementById("convo");
  const top = scroller.getBoundingClientRect().top;
  const blocks = [...(convo?.children ?? [])];
  const index = blocks.findIndex((b) => b.getBoundingClientRect().bottom > top);
  if (index === -1) return () => {};
  const offset = blocks[index].getBoundingClientRect().top;
  return () => {
    const block = document.getElementById("convo")?.children[index];
    if (block !== undefined) scroller.scrollTop += block.getBoundingClientRect().top - offset;
  };
}

const keepers = [];
const settlers = [];
/** `keep(regions)` runs before a swap replaces the regions, and the function it returns runs after. */
export function onSwap(keep) { keepers.push(keep); }
export function afterSwap(settle) { settlers.push(settle); }

/**
 * Swaps in each region whose inside, as the browser serializes it, differs from what the server last sent for it.
 * Regions hold buttons, links, the prompt box and tool output, so focus, the draft, what the reader opened or
 * closed, and their place in the conversation survive the swap.
 */
function swap(regions) {
  const changed = regions.map(([el, html]) => [el, html, comparable(html)]).filter(([el, , key]) => el !== null && served.get(el.id) !== key);
  if (changed.length === 0) return;
  const focused = changed.some(([el]) => el.contains(document.activeElement)) ? focusKey(document.activeElement) : null;
  const kept = keepers.map((keep) => keep(changed.map(([el]) => el)));
  const restoreScroll = anchor();
  for (const [el, html, key] of changed) {
    el.innerHTML = html;
    served.set(el.id, key);
  }
  for (const restore of kept) restore?.();
  for (const d of document.querySelectorAll("details[id]")) if (toggled.has(d.id)) d.open = toggled.get(d.id);
  if (focused !== null) document.querySelector(focused)?.focus({ preventScroll: true });
  restoreScroll();
  tick();
  for (const settle of settlers) settle();
}

// While the stream is open it alone writes the conversation, so a poll that started before a frame cannot put
// older text back. Its frames come in order: the region whole, then the parts that grew since.
export let stream = null;
let frames = 0;
// Which view the stream last rendered, which a poll of a streaming page names instead of rendering it.
let shows = null;
const streaming = () => stream?.readyState === EventSource.OPEN;
export function follow(url) {
  // A hidden page keeps none of the control plane's few streams, even when a refresh it began finishes later.
  if (url === undefined || document.visibilityState !== "visible" || (stream !== null && stream.readyState !== EventSource.CLOSED)) return;
  // EventSource reconnects by itself after a dropped connection. A refused one is closed for good, so the next
  // poll opens another.
  stream = new EventSource(url);
  shows = null;
  stream.addEventListener("message", (event) => {
    frames += 1;
    const frame = JSON.parse(event.data);
    const convo = document.getElementById("convo");
    if (convo === null) return;
    if (frame.convo !== undefined) {
      // Parsed and serialized as the poll's regions are, so an unchanged region compares equal.
      const fresh = document.createElement("template");
      fresh.innerHTML = frame.convo;
      swap([[convo, fresh.innerHTML]]);
    } else if (frame.grow !== undefined) {
      const slots = convo.querySelectorAll("[data-grow]");
      const restoreScroll = anchor();
      for (const [i, inside] of frame.grow) {
        const slot = slots[i];
        if (slot === undefined) continue;
        // A running tool's output scrolls by itself. A reader at its end follows it, as at the conversation's end.
        const stick = atEnd(slot);
        slot.innerHTML = inside;
        if (stick) slot.scrollTop = slot.scrollHeight;
      }
      restoreScroll();
    }
    if (frame.shows !== undefined) shows = frame.shows;
  });
}

let refreshing = null;
async function refresh() {
  const state = document.getElementById("refresh-state");
  try {
    const seen = frames;
    const url = new URL(location.href);
    if (streaming()) url.searchParams.set("streaming", "1");
    // A link that stalls mid-body would otherwise hold the refresh lock forever.
    const res = await fetch(url, { headers: { accept: "text/html" }, cache: "no-store", signal: AbortSignal.timeout(pollMs * 2) });
    if (!res.ok) throw new Error(`the control plane answered ${res.status}`);
    const next = new DOMParser().parseFromString(await res.text(), "text/html");
    // A queued thread that started has a thread page, whose regions the queued page has none of.
    if ((next.getElementById("queued") === null) !== (document.getElementById("queued") === null)) return void location.reload();
    const freshConvo = next.getElementById("convo");
    // A poll of a streaming page names the view it would show rather than rendering it.
    const named = freshConvo?.dataset.shows;
    const followed = streaming() || frames !== seen || named !== undefined;
    swap([...next.querySelectorAll("[data-live]")].filter((fresh) => !(followed && fresh.id === "convo")).map((fresh) => [document.getElementById(fresh.id), fresh.innerHTML]));
    // A stream owns its patch indices. Certify its rendered snapshot without replacing it under those patches.
    if (freshConvo && (named !== undefined ? named === shows : !followed || served.get("convo") === comparable(freshConvo.innerHTML))) {
      document.getElementById("convo").dataset.renderedReplyAt = freshConvo.dataset.renderedReplyAt ?? "";
    }
    follow(next.getElementById("convo")?.dataset.stream);

    // An archived or deleted thread stops counting visits, so follow the fresh page.
    const activity = next.querySelector("main")?.dataset.activity;
    if (activity === undefined) delete main.dataset.activity;
    else main.dataset.activity = activity;
    if (state !== null) state.textContent = "";
  } catch (err) {
    if (state !== null) state.textContent = `Not updated: ${err.message}. Retrying.`;
  }
}
export const refreshNow = () => (refreshing ??= refresh().finally(() => { refreshing = null; }));
/** A refresh that starts after an action, so the page shows its effect. One already in flight may predate it. */
export const refreshAfter = async () => { await refreshing; await refreshNow(); };

export function recordVisit() {
  const thread = main?.dataset.activity;
  if (thread === undefined) return;
  // A visit wakes a paused pylon, so a failed record is worth saying.
  api("POST", `/v1/threads/${thread}/activity`, { kind: "human" }).catch((err) => {
    showError("action-error", new Error(`This visit was not recorded, so a paused pylon stays paused: ${err.message}`));
  });
}

/**
 * Sends a request that needs the pylon running, as the CLI's whenRunning does: the first try wakes a paused pylon,
 * and a 409 is tried again once a second for up to 120 s, unless the thread is archived or deleted. `waiting` hears
 * each refusal while it waits.
 */
export async function whenRunning(thread, send, waiting = () => {}) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return await send();
    } catch (err) {
      if (err.status !== 409 || Date.now() >= deadline) throw err;
      const detail = await api("GET", `/v1/threads/${thread}`);
      if (detail.thread.status === "archived" || detail.thread.status === "deleted") throw err;
      waiting(err, detail);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** Markup built from the pylon's checkout. Its paths and diffs are the guest's, so they only ever go in as text. */
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...present(children));
  return node;
}
/** The children that are there, so a child given as `cond && el(...)` is left out rather than written as "false". */
export const present = (children) => children.filter((c) => c !== null && c !== false && c !== undefined);
/**
 * An image of the conversation or a diff that does not load becomes a note naming it. It stays, hidden, to load again
 * once the pylon runs, since a visit that wakes the pylon asks for its images before it runs.
 */
function shotGone(img) {
  const shot = img.closest(".shot");
  if (shot.hidden) return;
  shot.hidden = true;
  shot.after(el("p", { className: "shot-gone", textContent: `${img.alt} can't be shown now: its pylon is paused, or the file is gone` }));
}
/**
 * Each image that failed loads again once while the pylon runs, even one whose failure came after the poll that saw
 * the pylon start. A pause lets it try once more after the next start.
 */
export function retryShots(running) {
  if (!running) {
    for (const shot of document.querySelectorAll(".shot[data-retried]")) delete shot.dataset.retried;
    return;
  }
  for (const shot of document.querySelectorAll(".shot[hidden]:not([data-retried])")) {
    shot.dataset.retried = "";
    if (shot.nextElementSibling?.matches(".shot-gone")) shot.nextElementSibling.remove();
    shot.hidden = false;
    const img = shot.querySelector("img");
    img.src = img.getAttribute("src");
  }
}
document.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement && event.target.matches(".shot img")) shotGone(event.target);
}, true);
// An image that failed before this script ran sent its error to no listener.
for (const img of document.querySelectorAll(".shot img")) if (img.complete && img.currentSrc !== "" && img.naturalWidth === 0) shotGone(img);
