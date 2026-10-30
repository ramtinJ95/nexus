import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { GenerationTask, Harness, createRegistry, hook } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { checkoutReader, CheckoutRefused } from "../checkout-files.ts";
import { processStream } from "../process-stream.ts";
import type { PylonId } from "../ids.ts";
import { latestTurn, turnSnapshots } from "./turn-snapshot.ts";
import { scriptedModel, scriptedModels } from "./test-fixture.ts";
import { writeThread } from "./thread-doc.ts";
import { tempDir } from "../test-kit.ts";

for (const fails of [false, true]) {
  test(`a whole reply keeps one snapshot across generation tasks${fails ? ", even after capture fails" : " and reopen"}`, async (t) => {
    const scratch = await tempDir("nexus-turn-", t);
    const dir = join(scratch, "repo");
    await mkdir(dir);
    const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", dir, ...args])).stdout.trim();
    await git("init", "-q");
    await git("config", "user.name", "test");
    await git("config", "user.email", "test@example.com");
    await writeFile(join(dir, "app.txt"), "before\n");
    await git("add", "app.txt");
    await git("commit", "-qm", "initial");
    const open = async (argv: readonly string[]) => processStream(argv[0]!, argv.slice(1), () => {});
    const reader = checkoutReader(open, dir);
    if (fails) await reader.snapshot("previous-reply");
    const captures: string[] = [];
    const tasks: number[] = [];
    const logs: string[] = [];
    const registry = createRegistry();
    registry.install(CodingTools);
    let harness: Harness;
    registry.install(turnSnapshots(() => harness, async (_pylon, turn) => {
      captures.push(turn);
      if (fails) throw new Error("pipe lost");
      await reader.snapshot(turn);
    }, (line) => logs.push(line)));
    registry.install({ name: "test.tasks", hooks: [hook(GenerationTask, {
      beforeRequest: async (_request, api, ctx) => {
        tasks.push(api.taskId);
        assert.equal(await latestTurn(harness, api.conversationId, ctx), captures.at(-1));
      },
      afterTools: async (_assistant, _results, api, ctx) => {
        if (tasks.length !== 1) return;
        const conversation = (await harness.conversation(api.conversationId, ctx))!;
        await conversation.submit({ type: "input", content: "keep going", requestId: "steering", whenBusy: "steer" }, ctx);
      },
    })] });
    const models = scriptedModels();
    const stream = models.streamSimple.bind(models);
    let requests = 0;
    models.streamSimple = (model, input, options) => {
      const round = requests++ % 3;
      const command = round === 0
        ? `printf 'reply ${requests}\\n' > app.txt; git add app.txt; git commit -qm work`
        : `printf 'round two\\n' > untracked.txt`;
      return stream(model, round < 2 ? { ...input, messages: [{ role: "user", content: `bash: ${command}`, timestamp: Date.now() }] } : input, options);
    };
    const env = new NodeExecutionEnv({ cwd: dir });
    t.after(() => env.cleanup(context));
    const start = async () => Harness.open(await openNodeSqliteStorage(join(scratch, "harness.sqlite")), {
      models, registry, env: () => env,
    }, context);
    harness = await start();
    t.after(() => harness.close(context));
    const conversation = await harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: scriptedModel, cwd: dir },
      init: (tx, id) => writeThread(tx, id, { threadId: "test", pylonId: "pylon-test" as PylonId }),
    }, context);
    const first = await conversation.submit({ type: "input", content: "change app", requestId: "first" }, context);
    assert.equal((await first.wait(context)).status, "done");
    await conversation.waitForIdle(context);
    assert.equal(requests, 3);
    assert.equal(new Set(tasks).size, 3, "each tool round creates a new generation task");
    assert.deepEqual(captures, [`input:${first.id}`]);
    assert.equal(await readFile(join(dir, "app.txt"), "utf8"), "reply 1\n");
    const scope = await latestTurn(harness, conversation.id, context);
    assert.equal(scope, captures[0]);
    const scoped = checkoutReader(open, dir, undefined, scope);
    if (fails) {
      assert.deepEqual(logs, ["latest-turn snapshot failed: pipe lost"]);
      await assert.rejects(scoped.changes("turn"), (err) => err instanceof CheckoutRefused && err.kind === "no-base");
    } else {
      const changes = await scoped.changes("turn");
      assert.ok(changes.files.some((file) => file.path === "app.txt"));
      assert.ok(changes.files.some((file) => file.path === "untracked.txt"));
      assert.match((await scoped.diff("turn", ["app.txt"])).diff, /-before\n\+reply 1/);
    }
    await harness.close(context);
    harness = await start();
    assert.equal(await latestTurn(harness, conversation.id, context), scope, "the reply identity survives reopening");
    const reopened = (await harness.conversation(conversation.id, context))!;
    const second = await reopened.submit({ type: "input", content: "change again", requestId: "second" }, context);
    assert.equal((await second.wait(context)).status, "done");
    await reopened.waitForIdle(context);
    assert.deepEqual(captures, [`input:${first.id}`, `input:${second.id}`]);
    assert.equal(requests, 6);
    const nextScope = await latestTurn(harness, conversation.id, context);
    assert.equal(nextScope, captures[1]);
    if (!fails) assert.match((await checkoutReader(open, dir, undefined, nextScope).diff("turn", ["app.txt"])).diff, /-reply 1\n\+reply 4/);
  });
}
