import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalOnlyReason } from "./slash.js";

test("a command that ends or replaces Claude's session is not typed, and the reason points to the pylon's terminal", () => {
  for (const text of ["/clear", "  /clear  ", "/reset", "/new", "/resume", "/resume 0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90", "/continue", "/exit", "/quit", "/branch", "/fork", "/Clear"]) {
    const reason = terminalOnlyReason(text, "th-1");
    assert.match(reason ?? "", /ends or replaces Claude's session, and Nexus follows only the session the worker started/, text);
    assert.match(reason, /nexus attach th-1/, text);
  }
});

test("a command that opens a picker is not typed, unless an argument makes it act at once", () => {
  for (const text of ["/model", "/effort", "/config", "/config theme=dark", "/permissions", "/mcp", "/rewind", "/status", "/help", "/add-dir /tmp"]) {
    assert.match(terminalOnlyReason(text, "th-1") ?? "", /opens a picker that only keys drive.*nexus attach th-1/, text);
  }
  for (const text of ["/model sonnet", "/effort high", "/model\topus"]) assert.equal(terminalOnlyReason(text, "th-1"), null, text);
});

test("other messages and slash commands are typed as written", () => {
  for (const text of ["/compact", "/review", "/poteto-mode fix the build", "/clearly not a command", "please /clear the cache", "clear", "/", "//clear", "!ls", "/hooks-audit"]) {
    assert.equal(terminalOnlyReason(text, "th-1"), null, text);
  }
});
