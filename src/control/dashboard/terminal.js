// A thread page's browser terminal: the attach route's WebSocket, as docs/cli.md describes it, joined to a terminal
// such as xterm.js. It lands where `nexus attach` does, and Herdr keeps its sessions when the terminal ends.

/** The attach route for a terminal of `size` on the page's own host, which the route checks against the Origin. */
export function attachUrl(location, thread, { cols, rows }) {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/threads/${encodeURIComponent(thread)}/attach?cols=${cols}&rows=${rows}&term=xterm-256color`;
}

/**
 * The terminal's status for each message of the route: `attached` clears it, and `exit` and `error` end the terminal.
 * A type this end does not know is ignored, as the route's contract asks.
 */
export function statusOf(message) {
  switch (message.type) {
    case "waiting": return { text: `Waiting for the pylon, which is ${message.pylon}. Attaching wakes it.`, over: false };
    case "attached": return { text: null, over: false };
    case "exit": return { text: message.code === 0 ? "Detached from Herdr. Its sessions keep running." : `Herdr exited with code ${message.code}. Its sessions keep running.`, over: true };
    case "error": return { text: message.message, over: true };
    default: return undefined;
  }
}

/** A close before any message is a refusal, which a browser's WebSocket cannot read, such as an archived thread's. */
const refused = { text: "The terminal could not attach. The thread may be archived, or the control plane unreachable.", over: true };
const dropped = { text: "The connection dropped. Herdr keeps the session, so attach again.", over: true };

/**
 * Joins `term` to the attach route over `socket`: keys go as binary messages, each resize as a resize message, and
 * the pylon's output is written to `term`. `status` hears each change, and once with `over`. Returns its detach.
 */
export function joinTerminal(term, socket, status) {
  let heard = false;
  let over = false;
  const end = (s) => {
    if (over) return;
    over = true;
    status(s);
  };
  const encoder = new TextEncoder();
  const send = (data) => { if (!over && socket.readyState === 1) socket.send(data); };
  socket.binaryType = "arraybuffer";
  // The terminal may be resized while the socket connects, and a resize before `attached` replaces the size it opens with.
  socket.addEventListener("open", () => send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })));
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
    if (message.type === "attached") term.focus();
  });
  socket.addEventListener("close", () => end(heard ? dropped : refused));
  const typed = term.onData((data) => send(encoder.encode(data)));
  const binary = term.onBinary((data) => send(Uint8Array.from(data, (c) => c.charCodeAt(0))));
  const resized = term.onResize(({ cols, rows }) => send(JSON.stringify({ type: "resize", cols, rows })));
  return () => {
    for (const listener of [typed, binary, resized]) listener.dispose();
    end({ text: "Detached. Herdr keeps its sessions running.", over: true });
    socket.close();
  };
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
