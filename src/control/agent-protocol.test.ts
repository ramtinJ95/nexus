import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { latest, mint, tokenBlocks } from "./agent-protocol.ts";

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
