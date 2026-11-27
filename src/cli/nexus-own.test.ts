import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { main } from "./main.ts";
import { setup } from "../test-support/cli-kit.ts";
import { alice, bob } from "../test-support/api-kit.ts";
import { tailnet } from "../test-support/people.ts";
import { peopleOf } from "../control/people.ts";

const value = "alice-mcp-made-up-0000";
const people = peopleOf({ [tailnet.alice.UserProfile!.LoginName]: "admin", [tailnet.bob.UserProfile!.LoginName]: "engineer" });

test("a person adds a host and a secret, reads back their names and hosts, and an admin lists each person's", async (t) => {
  const s = await setup(t, { people });
  s.callAs(alice);
  const host = await s.nexus(["host", "add", "mcp.alice.example"]);
  assert.equal(host.code, 0, host.stderr);
  const set = await s.nexus(["secret", "set", "MCP_TOKEN", "mcp.alice.example"], undefined, `${value}\n`);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /^Stored your secret MCP_TOKEN\. .*\nHosts and secrets of alice@example\.com, .*\nhosts: mcp\.alice\.example\nsecrets: MCP_TOKEN → mcp\.alice\.example\n$/s);
  assert.deepEqual(await s.json(["own"]), { person: "alice@example.com", hosts: ["mcp.alice.example"], secrets: [{ name: "MCP_TOKEN", hosts: ["mcp.alice.example"] }] });
  const listed = await s.nexus(["people"]);
  assert.equal(listed.stdout, [
    "Person             Role      Hosts              Secrets",
    "alice@example.com  admin     mcp.alice.example  MCP_TOKEN → mcp.alice.example",
    "bob@example.com    engineer  none               none",
    "",
  ].join("\n"));

  s.callAs(bob);
  const own = await s.nexus(["own"]);
  assert.equal(own.stdout, "Hosts and secrets of bob@example.com, for their own pylons from each one's start:\nhosts: none\nsecrets: none\n", "bob sees none of alice's as his");
  const refused = await s.nexus(["people"]);
  assert.equal(refused.code, 3, "an engineer may not list people");
  assert.match(refused.stderr, /only an admin may/);
  for (const run of [host, set, listed, own, refused]) assert.ok(!`${run.stdout}${run.stderr}`.includes(value), "no output holds the value");
});

test("secret set refuses a terminal's stdin and an empty one before it calls the API, and a solo install refuses these commands", async (t) => {
  const s = await setup(t);
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let shown = "";
  stderr.on("data", (chunk: Buffer) => { shown += chunk.toString(); });
  const before = s.requests();
  assert.equal(await main(["secret", "set", "MCP_TOKEN", "mcp.alice.example"], { stdin, stdout: new PassThrough(), stderr, env: s.env() }), 64);
  assert.match(shown, /reads the value from stdin, so a terminal never shows it\. Pipe it in, such as: pbpaste \| nexus secret set MCP_TOKEN mcp\.alice\.example/);
  assert.match((await s.nexus(["secret", "set", "MCP_TOKEN", "mcp.alice.example"], undefined, "\n")).stderr, /read no value from stdin/);
  assert.equal(s.requests(), before, "neither reached the API");
  for (const args of [["own"], ["host", "add", "mcp.alice.example"], ["people"]]) {
    const solo = await s.nexus(args);
    assert.equal(solo.code, 5, args.join(" "));
    assert.match(solo.stderr, /a solo install keeps no hosts or secrets of one person's.*nexus project edit <id> --allow-host HOST/);
  }
});
