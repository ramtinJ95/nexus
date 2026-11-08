import { test } from "node:test";
import assert from "node:assert/strict";
import { pages } from "./contract.ts";
import { pageModules } from "./pages.js";

test("each page that names its modules has them, and no others are listed", () => {
  assert.deepEqual(Object.keys(pageModules).sort(), [...pages].sort());
});
