/**
 * The commands that give every resource the same shape: `images`, `node show` and `thread show` beside the commands
 * they name, several threads to archive, unarchive, delete and seen, and `cat` of one file of a pylon's checkout,
 * against the control plane's real API with a fake harness and probe behind it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Thread } from "../control/thread-store.ts";
import type { NodeHealth } from "../protocol/client.ts";
import { processStream } from "../process-stream.ts";
import { checkoutDir } from "../../images/pylon/nexus-contract.ts";
import { tempDir, testCapacity, testObservation } from "../test-support/kit.ts";
import { node, image, setup } from "../test-support/cli-kit.ts";

test("images, node show and thread show print what image list, node and show print", async (t) => {
  const s = await setup(t);
  s.registry.threads.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  s.registry.threads.ingested(testObservation(node, { artifacts: [image.id] }), []);
  const health: NodeHealth = {
    node, readAt: "2027-01-01T00:00:00.000Z", cpus: 4, load: null, memory: null,
    disk: { path: "/var/lib/nexus", totalGiB: 100, freeGiB: 50 }, temperatures: null, pylons: [],
  };
  s.nodeHealth(async () => health);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "aliased"]);

  for (const [alias, named] of [[["images"], ["image", "list"]], [["node", "show", node], ["node", node]], [["thread", "show", thread.id.slice(0, 8)], ["show", thread.id]]]) {
    const [given, plain] = [await s.nexus(alias!), await s.nexus(named!)];
    assert.equal(given.code, 0, given.stderr);
    assert.equal(given.stdout, plain.stdout, `${alias!.join(" ")} prints what ${named!.join(" ")} prints`);
    assert.deepEqual(await s.json(alias!), await s.json(named!), `and the same --json`);
  }
  assert.match((await s.nexus(["node", "--help"])).stdout, /nexus node \[show\] <name>/, "node's help names both spellings");
  assert.equal((await s.nexus(["node"])).code, 64, "node alone still wants a name");
});

test("archive, unarchive, delete and seen take several threads, and one that fails stops none of the rest", async (t) => {
  const s = await setup(t);
  const first: Thread = await s.json(["start", "--project", "acme", "--title", "first"]);
  const second: Thread = await s.json(["start", "--project", "acme", "--title", "second"]);
  const gone = "th-000000000000";

  const one = await s.nexus(["archive", first.id]);
  assert.deepEqual([one.code, one.stdout], [0, `Archived ${first.id}.\n`], "one thread prints as it always has");
  const unarchived: Thread = await s.json(["unarchive", first.id]);
  assert.equal(unarchived.id, first.id, "and its --json is still the thread, not a list");
  const missing = await s.nexus(["archive", gone]);
  assert.deepEqual([missing.code, missing.stdout, missing.stderr], [4, "", `nexus: no thread ${gone}\n`], "one failure is still the command's own");

  const archived = await s.nexus(["archive", first.id, gone, second.id.slice(0, 8)]);
  assert.equal(archived.code, 4, "the exit code is the failure's");
  assert.equal(archived.stdout, `Archived ${first.id}.\n${gone}: no thread ${gone}\nArchived ${second.id}.\n`, "one line each, in the order given");
  assert.equal(s.registry.threads.thread(second.id)!.status, "archived", "the thread after the failure was archived");

  const unarchive = await s.nexus(["unarchive", first.id, gone, second.id, "--json"]);
  assert.equal(unarchive.code, 4);
  const outcomes = JSON.parse(unarchive.stdout);
  assert.deepEqual(outcomes.map((o: { given: string; reply?: Thread }) => [o.given, o.reply?.status]), [[first.id, "active"], [gone, undefined], [second.id, "active"]]);
  assert.deepEqual(outcomes[1], { given: gone, error: `no thread ${gone}`, kind: "not-found", status: 404, code: null }, "a failure's entry has the fields stderr would print");

  const seen = await s.nexus(["seen", first.id, second.id, "--json"]);
  assert.deepEqual([seen.code, JSON.parse(seen.stdout)], [0, [{ given: first.id, reply: null }, { given: second.id, reply: null }]]);
  assert.equal((await s.nexus(["seen", first.id, second.id, "--unread"])).stdout, `Marked ${first.id} unread.\nMarked ${second.id} unread.\n`);
  const refused = await s.nexus(["seen", first.id, second.id, "--unread", "--last-reply-at", "5"]);
  assert.deepEqual([refused.code, refused.stdout], [64, ""], "a usage error fails before any thread");

  const deleted = await s.nexus(["delete", gone, first.id, second.id]);
  assert.deepEqual([deleted.code, deleted.stdout], [4, `${gone}: no thread ${gone}\nDeleted ${first.id}.\nDeleted ${second.id}.\n`], "a failure first stops none after it");
  assert.deepEqual([first.id, second.id].map((id) => s.registry.threads.thread(id)!.status), ["deleted", "deleted"]);
});

test("cat writes one file of the pylon's checkout as its bytes, and waits for a paused pylon to run", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "cat"]);
  const repo = await tempDir("nexus-cli-cat-", t);
  await promisify(execFile)("git", ["-C", repo, "init", "-q"]);
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "app.ts"), "export const café = 1;\nno final line break");
  let refusals = 2;
  s.probePipes(async (argv) => {
    if (refusals-- > 0) throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" });
    return processStream(argv[0]!, argv.slice(1).map((arg) => arg === checkoutDir ? repo : arg), () => {});
  });

  const read = await s.nexus(["cat", thread.id.slice(0, 8), "src/app.ts"]);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(read.stdout, "export const café = 1;\nno final line break", "the file as it is, woken and asked again until the pylon runs, with nothing added");
  assert.equal(read.stderr, "");

  const absent = await s.nexus(["cat", thread.id, "nope.txt"]);
  assert.equal(absent.code, 4);
  assert.match(absent.stderr, /nope\.txt does not exist/);
  assert.equal((await s.nexus(["cat", thread.id, "src"])).code, 64, "a directory is not a file");
  const json = await s.nexus(["cat", thread.id, "src/app.ts", "--json"]);
  assert.deepEqual([json.code, json.stdout], [64, ""], "cat takes no --json");
});
