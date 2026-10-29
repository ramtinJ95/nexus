// The slash commands a Claude worker's composer does not type, because typing them from the page cannot do what the
// person means: client.js says why and points to the pylon's terminal instead.

/**
 * `session` commands end or replace Claude's session, which Nexus follows only by the ID the worker's launch gave it.
 * `picker` commands open a picker or panel that only keys drive, and Herdr reports Claude idle while one is open, so the
 * next message would be typed into it. `bare-picker` commands open one only when typed without an argument.
 */
const terminalOnly = {
  clear: "session", reset: "session", new: "session", resume: "session", continue: "session", exit: "session", quit: "session", branch: "session", fork: "session",
  model: "bare-picker", effort: "bare-picker",
  config: "picker", settings: "picker", permissions: "picker", "allowed-tools": "picker", agents: "picker", mcp: "picker", hooks: "picker", memory: "picker",
  plugin: "picker", plugins: "picker", theme: "picker", "output-style": "picker", rewind: "picker", checkpoint: "picker", status: "picker", help: "picker",
  login: "picker", logout: "picker", export: "picker", ide: "picker", doctor: "picker", usage: "picker", "add-dir": "picker",
};

/** Why the composer does not type `text` into the Claude worker of `thread`, for the person to read, or null. */
export function terminalOnlyReason(text, thread) {
  const [, name, argument] = /^\/([A-Za-z][\w-]*)(\s+\S)?/.exec(text.trim()) ?? [];
  const kind = name !== undefined && Object.hasOwn(terminalOnly, name.toLowerCase()) ? terminalOnly[name.toLowerCase()] : undefined;
  if (kind === undefined || (kind === "bare-picker" && argument !== undefined)) return null;
  const terminal = `Type it in the pylon's terminal (nexus attach ${thread})`;
  return kind === "session"
    ? `/${name} ends or replaces Claude's session, and Nexus follows only the session the worker started, so this page would stop showing what Claude does and its messages would go to the old session. ${terminal} if you mean to leave it.`
    : `/${name} opens a picker that only keys drive, so it is not typed from here. ${terminal}.`;
}
