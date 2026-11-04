/** Standing rules: a project's Markdown that each builder thread it starts gets with its first message. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectId } from "../ids.ts";
import { project, testApi } from "./api-test-kit.ts";

const rules = "- Run npm test before you push.\n- Keep commits small.";
type Api = Awaited<ReturnType<typeof testApi>>;
const setRules = async (s: Api, standingRules: string | null) => {
  const edited = await s.call("PATCH", "/v1/projects/acme", { standingRules });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  return edited.body.standingRules;
};

test("a person sets, changes and clears a project's standing rules, and each change counts a revision that never goes back", async (t) => {
  const s = await testApi(t);
  assert.deepEqual(await s.call("POST", "/v1/projects", project), { status: 201, body: project });
  assert.deepEqual(await setRules(s, `\n  ${rules}  \n`), { text: rules, revision: 1 }, "the text is kept trimmed");
  assert.deepEqual(await setRules(s, rules), { text: rules, revision: 1 }, "the same text is no change");
  assert.deepEqual(await setRules(s, "- Rebase first."), { text: "- Rebase first.", revision: 2 });
  assert.deepEqual(await setRules(s, null), { text: null, revision: 3 });
  assert.deepEqual(await setRules(s, null), { text: null, revision: 3 });
  assert.deepEqual(await setRules(s, rules), { text: rules, revision: 4 }, "a set after a clear counts on");
  assert.deepEqual((await s.call("PATCH", "/v1/projects/acme", { defaultBranch: "trunk" })).body.standingRules, { text: rules, revision: 4 }, "another edit keeps them");
  assert.deepEqual((await s.call("GET", "/v1/projects")).body, [{ ...project, defaultBranch: "trunk", standingRules: { text: rules, revision: 4 } }]);

  const stored = s.registry.project("acme" as ProjectId);
  for (const standingRules of ["", "  \n ", "x".repeat(8_193), "a\0b", 7, { text: "x", revision: 9 }]) {
    assert.equal((await s.call("PATCH", "/v1/projects/acme", { standingRules })).status, 400, JSON.stringify(standingRules).slice(0, 40));
  }
  assert.deepEqual(s.registry.project("acme" as ProjectId), stored, "no refused edit changed the project");
  assert.deepEqual(await setRules(s, "x".repeat(8_192)), { text: "x".repeat(8_192), revision: 5 }, "8192 characters fit");

  const added = await s.call("POST", "/v1/projects", { ...project, id: "ruled", standingRules: rules });
  assert.deepEqual(added, { status: 201, body: { ...project, id: "ruled", standingRules: { text: rules, revision: 1 } } });
  assert.deepEqual(s.registry.project("ruled" as ProjectId)?.standingRules, { text: rules, revision: 1 });
  for (const standingRules of ["", "x".repeat(8_193), { text: rules, revision: 7 }]) {
    assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "refused", standingRules })).status, 400);
  }
  assert.equal(s.registry.project("refused" as ProjectId), undefined);

  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "plain" })).status, 201);
  assert.deepEqual((await s.call("PATCH", "/v1/projects/plain", { standingRules: null })).body, { ...project, id: "plain" }, "clearing rules never set leaves none");
});
