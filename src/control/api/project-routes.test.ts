import { test } from "node:test";
import assert from "node:assert/strict";
import { project, testApi } from "../../test-support/api-kit.ts";
import { tailnet, type WhoisAnswer } from "../../test-support/people.ts";
import { parseWhois, type TailnetCaller } from "../../node-base/tailscaled.ts";
import { peopleOf } from "../people.ts";

const people = peopleOf({ [tailnet.alice.UserProfile!.LoginName]: "admin", [tailnet.bob.UserProfile!.LoginName]: "engineer" });
const answer = (a: WhoisAnswer): TailnetCaller => ({ id: a.Node.StableID, ...parseWhois(a).identity });

test("on a shared install an engineer reads projects and an admin alone adds, edits and removes them", async (t) => {
  let caller = answer(tailnet.alice);
  const s = await testApi(t, { people, allowed: new Set(), whois: async () => caller });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201, "alice, an admin, adds a project");

  caller = answer(tailnet.bob);
  const refused = [
    ["PATCH", "/v1/projects/acme", { defaultBranch: "bob's" }, "edit a project"],
    ["POST", "/v1/projects", { ...project, id: "bobs" }, "add a project"],
    ["DELETE", "/v1/projects/acme", {}, "remove a project"],
  ] as const;
  for (const [method, path, body, action] of refused) {
    const r = await s.call(method, path, body);
    assert.deepEqual([r.status, r.body.error], [403, `caller may not ${action}: only an admin may`], `bob's ${method} ${path}`);
  }
  const listed = await s.call("GET", "/v1/projects");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map((p: { id: string; defaultBranch: string; removed?: unknown }) => [p.id, p.defaultBranch, p.removed]), [["acme", "main", undefined]], "bob reads the project his refusals left as it was");

  caller = answer(tailnet.alice);
  const edited = await s.call("PATCH", "/v1/projects/acme", { defaultBranch: "next" });
  assert.deepEqual([edited.status, edited.body.defaultBranch], [200, "next"], "alice's edit succeeds");
  assert.equal((await s.call("DELETE", "/v1/projects/acme", {})).status, 200, "alice's remove succeeds");
});

test("a solo install lets its person add, edit and remove a project as before people", async (t) => {
  const s = await testApi(t);
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { defaultBranch: "next" })).status, 200);
  assert.equal((await s.call("DELETE", "/v1/projects/acme", {})).status, 200);
});
