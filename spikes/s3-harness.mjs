import assert from 'node:assert/strict';
import { VM } from '@earendil-works/gondolin';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createModels } from '@earendil-works/pi-ai/models';
import { GondolinExecutionEnv } from './s3-env.mjs';

const model = { id: 'scripted', name: 'Scripted offline fixture', provider: 'nexus-fixture',
  api: 'nexus-scripted', baseUrl: 'http://unused.invalid', input: ['text'], reasoning: false,
  contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let calls = 0;
// Empty collection: no providers, credentials or network clients.
const models = Object.assign(createModels(), {
  getModel: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
  streamSimple: (_model, input) => {
    const turn = calls++;
    assert.ok(turn < 2, 'scripted fixture must run exactly twice');
    if (turn === 1) {
      assert.match(JSON.stringify(input.messages), /nexus-marker-via-vm-fs/);
      assert.match(JSON.stringify(input.messages), /Alpine Linux/);
      console.log('FAKE_MODEL_RECEIVED_GUEST_TOOL_RESULT=true');
    }
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: turn === 0 ? 'toolUse' : 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...model.cost, total: 0 } },
      content: turn === 0 ? [{ type: 'toolCall', id: 'fixture-bash-1', name: 'bash', arguments: {
        command: 'uname -a; cat /etc/os-release; cat marker.txt; printf "guest-stderr\\n" >&2', timeout: 20,
      }}] : [{ type: 'text', text: 'Verified guest tool result from the scripted model.' }] };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: message.stopReason, message });
    return stream;
  },
});
let vm, harness, env;
const start = performance.now();
try {
  vm = await VM.create({ sessionLabel: 'nexus-s3-harness', sandbox: { vmm: 'qemu', accel: 'kvm' }, startTimeoutMs: 60000 });
  const first = await vm.exec('true');
  assert.equal(first.exitCode, 0);
  console.log(`CACHED_ASSETS_COLD_BOOT_FIRST_EXEC_MS=${Math.round(performance.now() - start)}`);
  env = new GondolinExecutionEnv(vm);
  assert.equal((await env.createDir('.', { recursive: true }, context)).ok, true);
  assert.equal((await env.writeFile('marker.txt', 'nexus-marker-via-vm-fs\n', context)).ok, true);
  assert.equal((await env.readTextFile('marker.txt', context)).value, 'nexus-marker-via-vm-fs\n');
  const registry = createRegistry();
  registry.install(CodingTools);
  harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env,
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    onReport: (e, info) => console.error('HARNESS_REPORT', e.message, info.type),
  }, context);
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, cwd: env.cwd } });
  const toolStart = performance.now();
  const submission = await root.submit({ type: 'input', content: 'Run the offline guest probe.' }, context);
  const settled = await submission.wait(context);
  console.log('SUBMISSION', JSON.stringify(settled));
  const view = await root.viewState(context);
  console.log('TRANSCRIPT', JSON.stringify(view.value.entries, null, 2));
  assert.equal(settled.status, 'done');
  assert.equal(calls, 2);
  assert.match(JSON.stringify(view.value.entries), /pi.tool-result/);
  assert.match(JSON.stringify(view.value.entries), /Alpine Linux/);
  view.dispose();
  console.log(`HARNESS_TOOL_ROUND_MS=${Math.round(performance.now() - toolStart)}`);
  console.log('S3_PASS');
} finally {
  await harness?.close(context);
  await env?.cleanup(context);
  await vm?.close();
}
