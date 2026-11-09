import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { endingBlock, judgmentPrefix, latest, mint, planningPrefix, senders, tokenBlocks } from "./agent-protocol.ts";

const schema = z.object({ token: z.string(), verdict: z.enum(["approve", "changes"]) });
const fenced = (fence: string, body: string) => `\`\`\`${fence}\n${body}\n\`\`\``;

test("tokenBlocks takes only the blocks of its fence that parse, match the schema and echo the token, oldest first", () => {
  const token = mint("rv-1");
  assert.match(token, /^rv-1:[0-9a-f]{12}$/);
  const replies = [
    fenced("nexus-review", JSON.stringify({ token, verdict: "changes" })),
    `Some prose.\n${fenced("nexus-plan", JSON.stringify({ token, verdict: "approve" }))}`,
    fenced("nexus-review", "{ not json"),
    fenced("nexus-review", JSON.stringify({ token, verdict: "maybe" })),
    fenced("nexus-review", JSON.stringify({ token: mint("rv-1"), verdict: "approve" })),
    fenced("nexus-review", JSON.stringify({ token, verdict: "approve" })),
  ];
  assert.deepEqual(tokenBlocks(replies, "nexus-review", schema, token), [{ token, verdict: "changes" }, { token, verdict: "approve" }]);
});

test("a block whose JSON string quotes a fence stays whole", () => {
  const quoted = z.object({ token: z.string(), detail: z.string() });
  const detail = "Run this:\n```sh\nnpm test\n```";
  const replies = [fenced("nexus-review", JSON.stringify({ token: "t", detail }, null, 2))];
  assert.deepEqual(tokenBlocks(replies, "nexus-review", quoted, "t"), [{ token: "t", detail }]);
});

test("latest is the newest matching block, or null when none matches", () => {
  const replies = [fenced("nexus-review", JSON.stringify({ token: "t", verdict: "changes" })), fenced("nexus-review", JSON.stringify({ token: "t", verdict: "approve" }))];
  assert.deepEqual(latest(replies, "nexus-review", schema, "t"), { token: "t", verdict: "approve" });
  assert.equal(latest(replies, "nexus-review", schema, "other"), null);
});

test("endingBlock takes only a block that nothing but whitespace follows", () => {
  const block = fenced("nexus-review", JSON.stringify({ token: "t", verdict: "approve" }));
  assert.deepEqual(endingBlock(`Checked.\n\n${block}\n`, "nexus-review", schema, "t"), { token: "t", verdict: "approve" });
  assert.equal(endingBlock(`${block}\nCorrection: changes are required.`, "nexus-review", schema, "t"), null);
  assert.equal(endingBlock(`${block}\nCorrection: changes are required.\n${fenced("ts", "const x = 1;")}`, "nexus-review", schema, "t"), null, "a later block of another fence does not stand in for its closing fence");
  const quoting = z.object({ token: z.string(), reason: z.string() });
  const reason = "the brief asked for a ```nexus-review block";
  assert.deepEqual(endingBlock(fenced("nexus-review", JSON.stringify({ token: "t", reason })), "nexus-review", quoting, "t"), { token: "t", reason }, "a fence quoted in its JSON is not where the block starts");
});

test("each automated sender keeps its name and the prefix its messages start with", (t) => {
  const each = (field: "name" | "prefix") => Object.fromEntries(Object.entries(senders).map(([s, v]) => [s, v[field]] as const).sort(([a], [b]) => a.localeCompare(b)));
  t.assert.snapshot({ names: each("name"), prefixes: each("prefix"), judgment: judgmentPrefix, planning: planningPrefix });
});
