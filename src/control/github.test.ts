import { test } from "node:test";
import assert from "node:assert/strict";
import { controlGitHub } from "./github.ts";
import { peopleOf, solo } from "./people.ts";

test("a shared install's GitHub client has no merge and no branch update, and a solo install's landing has both", () => {
  const shared = controlGitHub("token", peopleOf({ "alice@example.com": "admin" }));
  assert.equal(shared.landing, null);
  assert.deepEqual(["merge", "update"].filter((name) => name in shared.github), []);
  const { landing } = controlGitHub("token", solo);
  assert.deepEqual(Object.keys(landing!).sort(), ["merge", "update"]);
});
