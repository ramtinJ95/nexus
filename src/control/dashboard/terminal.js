// A thread page's browser terminal: the attach route's WebSocket, as docs/cli.md describes it, joined to a terminal
// such as xterm.js. It lands where `nexus attach` does, and Herdr keeps its sessions when the terminal ends.
import { attachPath, defaultTerm, encodeMessage } from "../../attach-route.ts";

/**
 * The attach route for a terminal of `size` on the page's own host, which the route checks against the Origin. It
 * lands in `pane` when that is given, and otherwise where `nexus attach` does.
 */
export function attachUrl(location, thread, { cols, rows }, pane = null) {
  const path = attachPath(thread, { size: { cols, rows }, term: defaultTerm, ...(pane === null ? {} : { pane }) });
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}

/**
 * The terminal's status for each message of the route: `attached` clears it, and `exit` and `error` end the terminal.
 * A type this end does not know is ignored, as the route's contract asks.
 */
function statusOf(message) {
  switch (message.type) {
    case "waiting": return { text: `Waiting for the pylon, which is ${message.pylon}. Attaching wakes it.`, over: false };
    case "attached": return { text: null, over: false };
    case "exit": return { text: message.code === 0 ? "Detached from Herdr. Its sessions keep running." : `Herdr exited with code ${message.code}. Its sessions keep running.`, over: true, why: "exit" };
    case "error": return { text: message.message, over: true, why: "error", kind: message.kind };
    default: return undefined;
  }
}

/** A close before any message is a refusal, which a browser's WebSocket cannot read, such as an archived thread's. */
const refused = { text: "The terminal could not attach. The thread may be archived, or the control plane unreachable.", over: true, why: "refused" };
const dropped = { text: "The connection dropped. Herdr keeps the session, so attach again.", over: true, why: "dropped" };
const detached = { text: "Detached. Herdr keeps its sessions running.", over: true, why: "detached" };

/**
 * Joins `term` to the attach route over `socket`: keys go as binary messages once it is attached, each resize as a
 * resize message, and the pylon's output is written to `term`. `status` hears each change, and once with `over` and
 * `why` it ended: `exit`, `error` with the error's `kind`, `refused`, `dropped` or `detached`. Returns its detach.
 */
export function joinTerminal(term, socket, status) {
  let heard = false;
  let attached = false;
  let over = false;
  const end = (s) => {
    if (over) return;
    over = true;
    status(s);
  };
  const encoder = new TextEncoder();
  const send = (data) => { if (!over && socket.readyState === 1) socket.send(data); };
  // Keys typed while a reattach waits would land in the session it reaches, unseen.
  const sendKeys = (data) => { if (attached) send(data); };
  socket.binaryType = "arraybuffer";
  // The terminal may be resized while the socket connects, and a resize before `attached` replaces the size it opens with.
  socket.addEventListener("open", () => send(encodeMessage({ type: "resize", size: { cols: term.cols, rows: term.rows } })));
  socket.addEventListener("message", ({ data }) => {
    heard = true;
    if (typeof data !== "string") return term.write(new Uint8Array(data));
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const s = statusOf(message);
    if (s === undefined) return;
    if (s.over) return end(s);
    status(s);
    if (message.type !== "attached") return;
    attached = true;
    term.focus();
  });
  socket.addEventListener("close", () => end(heard ? dropped : refused));
  const typed = term.onData((data) => sendKeys(encoder.encode(data)));
  const binary = term.onBinary((data) => sendKeys(Uint8Array.from(data, (c) => c.charCodeAt(0))));
  const resized = term.onResize(({ cols, rows }) => send(encodeMessage({ type: "resize", size: { cols, rows } })));
  return () => {
    for (const listener of [typed, binary, resized]) listener.dispose();
    end(detached);
    socket.close();
  };
}

/**
 * What a key sends in place of xterm.js's own bytes: Shift+Enter and Option+Enter send ESC CR, a newline in Claude
 * Code's prompt. An Enter that confirms an input method's composition stays xterm.js's.
 */
export function keyFor(event) {
  if (event.isComposing || event.keyCode === 229) return undefined;
  if (event.key === "Enter" && (event.shiftKey || event.altKey) && !event.ctrlKey && !event.metaKey) return "\x1b\r";
  return undefined;
}

/**
 * The clipboard OSC 52 reaches, as @xterm/addon-clipboard asks for one. It writes the browser's one clipboard for
 * every selection but X11's primary, which would clobber it, and never reads it, so output in the pylon cannot see
 * what the person copied: a query gets empty data.
 */
export function clipboardOf(clipboard) {
  return {
    readText: () => "",
    // A browser refuses a write from a page without focus, and has no clipboard outside a secure context.
    writeText: async (selection, text) => { if (selection !== "p") await clipboard?.writeText(text).catch(() => {}); },
  };
}

/** How long a page stays attached while hidden, short of the 20 minutes without a human that pause a pylon. */
export const hiddenDetachMs = 10 * 60_000;
const maxTries = 8;

/** Whether a join that ended so may be tried again. A control plane that is restarting refuses a retry's upgrade. */
const transient = (s, retry) => s.why === "dropped" || (s.why === "error" && s.kind === "unreachable") || (s.why === "refused" && retry);

/**
 * Joins `term` as joinTerminal does over a socket `open()` gives, and again after the link drops: with backoff while
 * `page` shows, and once it shows when it was hidden. A page hidden for `hiddenDetachMs` detaches, so the pylon can
 * pause, and attaches again when it shows. `status` hears what joinTerminal says, and the waits between. Returns the
 * person's detach.
 */
export function keepAttached(term, open, status, page = document) {
  let state = { kind: "over" };
  let tries = 0;
  const enter = (next) => {
    const was = state;
    state = next;
    if (was.kind === "joined") {
      clearTimeout(was.hiding);
      was.detach();
    }
    if (was.kind === "retrying") clearTimeout(was.timer);
  };
  const end = (s) => {
    enter({ kind: "over" });
    page.removeEventListener("visibilitychange", visibility);
    status(s);
  };
  const sleep = (retry, text) => {
    enter({ kind: "asleep", retry });
    status({ text, over: false });
  };
  const untilShown = "The connection dropped. It attaches again when the page shows.";
  const join = (retry) => {
    const joined = { kind: "joined", retry, hiding: undefined, detach: () => {} };
    enter(joined);
    joined.detach = joinTerminal(term, open(), (s) => { if (state === joined) heard(joined, s); });
  };
  const heard = (joined, s) => {
    if (!s.over) {
      // `attached`: Herdr redraws the screen, and a reattach must not keep the modes the dropped client set.
      if (s.text === null) {
        tries = 0;
        term.reset();
      }
      return status(s);
    }
    if (!transient(s, joined.retry)) return end(s);
    // An unreachable error says why, such as a pylon that is not answering, and what to try.
    const why = s.why === "error" ? `${s.text[0].toUpperCase()}${s.text.slice(1).replace(/\.?$/, ".")}` : "The connection dropped.";
    if (tries === maxTries) return end({ text: `${why} Attaching again failed ${maxTries} times. Herdr keeps the session, so attach again.`, over: true });
    if (page.visibilityState === "hidden") return sleep(true, untilShown);
    const delay = Math.min(30_000, 1000 * 2 ** tries++);
    enter({ kind: "retrying", timer: setTimeout(() => (page.visibilityState === "hidden" ? sleep(true, untilShown) : join(true)), delay) });
    status({ text: `${why} Attaching again in ${delay / 1000} s.`, over: false });
  };
  const visibility = () => {
    if (page.visibilityState === "hidden") {
      if (state.kind === "joined") state.hiding ??= setTimeout(() => sleep(false, "Detached while the page was hidden, so the pylon can pause. It attaches again when the page shows."), hiddenDetachMs);
      return;
    }
    if (state.kind === "joined") {
      clearTimeout(state.hiding);
      state.hiding = undefined;
    }
    if (state.kind === "asleep") {
      tries = 0;
      join(state.retry);
    }
  };
  page.addEventListener("visibilitychange", visibility);
  join(false);
  visibility();
  return () => { if (state.kind !== "over") end(detached); };
}

/**
 * Whether the terminal's current connection has landed, from the statuses keepAttached gives and `term`'s writes: Herdr's
 * client draws after `attached`, once the attach focused its pane. A drop starts the wait again, so a focus asked for
 * then waits for the reattach, which focuses a pane of its own. `landed()` answers false once the terminal is over.
 */
export function landing(term) {
  let state = "joining";
  let waiting = [];
  const settle = (value) => {
    for (const resolve of waiting) resolve(value);
    waiting = [];
  };
  const drawn = term.onWriteParsed(() => {
    if (state !== "attached") return;
    state = "landed";
    settle(true);
  });
  return {
    heard({ text, over }) {
      if (state === "over") return;
      if (!over) return void (state = text === null ? "attached" : "joining");
      state = "over";
      drawn.dispose();
      settle(false);
    },
    landed: () => state === "landed" ? Promise.resolve(true) : state === "over" ? Promise.resolve(false) : new Promise((resolve) => waiting.push(resolve)),
  };
}
