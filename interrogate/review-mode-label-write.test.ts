/**
 * Team mode allows auto-review `review` (point 4) and says each engineer spends only their own GitHub credential
 * (point 3). The review loop in `review` mode (land: null) still writes to the engineer's pull request when its rounds
 * run out (review.test.ts "rounds that run out..."), and that write goes through main.ts's one githubClient(token),
 * built from control.json's single github.tokenFile, whoever owns the PR. This shows what that client sends.
 */
import { test } from "node:test";
import { githubClient } from "../src/control/github.ts";

test("the review loop's label write is a GitHub write made with the control plane's one token", async () => {
  const sent: string[] = [];
  const fake: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    sent.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname} Authorization: ${headers.get("authorization")}`);
    return Response.json([], { status: new URL(String(input)).pathname.endsWith("/repos/acme/mono/labels") ? 201 : 200 });
  };
  // The token file's content: the same for every engineer's pull request.
  const client = githubClient("ghp_CONTROL_PLANE_TOKEN", fake);
  console.log("label result:", JSON.stringify(await client.label("acme/mono", 42, "needs human review")));
  for (const line of sent) console.log(line);
});
