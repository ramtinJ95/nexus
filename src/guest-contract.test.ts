import { test } from "node:test";
import assert from "node:assert/strict";
import * as contract from "./guest-contract.ts";

test("each name and limit equals the literal it replaced", () => {
  const { asUser, onClaudeTranscript, herdrPanePattern, startHerdrServer, focusScript, attachScript, ...values } = contract;
  assert.deepEqual(values, {
    servicesActions: ["ensure", "list", "restart", "stop"],
    maxServiceLogLines: 500,
    execOutputMaxBytes: 65_536,
    callTimeoutMs: 10_000,
    herdrSession: "nexus",
    herdrClient: "herdr --session nexus",
    herdrServerStartMs: 5_000,
  });
  assert.equal(herdrPanePattern.source, "^w[0-9]{1,9}:p[0-9]{1,9}$");
  assert.equal(herdrPanePattern.flags, "");
  assert.deepEqual(asUser("id"), ["runuser", "-l", "user", "-c", "id"]);
  assert.equal(onClaudeTranscript("cat \"$f\"", 3), 'for f in "$1"/*/"$0".jsonl; do [ -e "$f" ] || continue; cat "$f"; exit 0; done; exit 3');
  assert.equal(startHerdrServer, "setsid -f tini -s -- herdr --session nexus server </dev/null >/dev/null 2>&1");
  assert.equal(focusScript, `herdr --session nexus agent focus "$1" >/dev/null 2>&1 || { tab=$(herdr --session nexus pane get "$1" 2>/dev/null | sed -n 's/.*"tab_id":"\\([^"]*\\)".*/\\1/p'); [ -n "$tab" ] && herdr --session nexus tab focus "$tab" >/dev/null 2>&1; }`);
  assert.equal(attachScript, `herdr --session nexus workspace list >/dev/null 2>&1 || { ${startHerdrServer}; i=0; until herdr --session nexus workspace list >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 50 ] || break; sleep 0.1; done; }; [ -z "$1" ] || { ${focusScript}; }; exec herdr --session nexus`);
});
