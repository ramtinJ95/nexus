/**
 * Today a node (here nFIREBAT, the control node, allowed in control.json) is kept out of the person role by its
 * Tailscale node ID alone (access.ts isPerson). On the one-person tailnet the nodes are untagged and owned by the
 * same Tailscale user as the person's devices (interrogate/tailnet-users.mjs), so a principal taken from whois's
 * user cannot tell them apart.
 */
import { test } from "node:test";
import { image, laptop, project, testApi } from "../src/test-support/api-kit.ts";
import type { ImageId, TailnetNodeId } from "../src/ids.ts";

test("the node/person split rests on node IDs, not on the tailnet user", async (t) => {
  const s = await testApi(t);
  s.callAs(laptop);
  await s.call("POST", "/v1/projects", project);
  await s.call("POST", "/v1/images", image);
  s.registry.images.setCurrentImage(image.id as ImageId);
  for (const caller of [laptop, "nFIREBAT" as TailnetNodeId]) {
    s.callAs(caller);
    const r = await s.call("POST", "/v1/threads", { project: "acme", title: "x" });
    console.log(`${caller}: POST /v1/threads -> ${r.status} ${r.status === 201 ? "" : JSON.stringify(r.body)}`);
  }
});
