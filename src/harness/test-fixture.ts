/**
 * Test support for src/harness/slice.test.ts. A scripted model that needs no network: a user message
 * `bash: <command>` becomes one bash tool call, and a tool result becomes a short final answer.
 *
 * Run as a program, it is the harness process the test kills mid-tool:
 *   node src/harness/test-fixture.ts <ChildArgs JSON>
 * It opens the host, sends one message to the thread, prints `SENT`, and runs until killed.
 */
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import { openHarnessHost } from "./host.ts";
import type { ProbeAddress } from "./pylon-env.ts";

export const scriptedModel: ModelRef = { provider: "nexus-fixture", modelId: "scripted" };

const model = {
  id: scriptedModel.modelId, name: "Scripted offline fixture", provider: scriptedModel.provider, api: "nexus-scripted",
  baseUrl: "http://unused.invalid", input: ["text"], reasoning: false, contextWindow: 128_000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function text(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

export function scriptedModels(): Models {
  return Object.assign(createModels(), {
    getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    streamSimple: (_model: unknown, input: { messages: Message[] }) => {
      const last = input.messages.at(-1);
      if (last === undefined) throw new Error("the scripted model got no messages");
      const command = last.role === "user" ? /^bash: ([\s\S]*)$/.exec(text(last))?.[1] : undefined;
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: command === undefined ? "stop" : "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...model.cost, total: 0 } },
        content: command === undefined
          ? [{ type: "text", text: `scripted answer after ${last.role}` }]
          : [{ type: "toolCall", id: `call-${input.messages.length}`, name: "bash", arguments: { command, timeout: 600 } }],
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message } as never);
      return stream;
    },
  }) as Models;
}

export interface ChildArgs {
  storagePath: string;
  tailscaled: string;
  probe: ProbeAddress;
  threadId: string;
  conversationId: ConversationId;
  command: string;
}

if (import.meta.main) {
  const args = JSON.parse(process.argv[2]!) as ChildArgs;
  const host = await openHarnessHost({
    storagePath: args.storagePath,
    models: scriptedModels(),
    model: scriptedModel,
    locator: { awaitRunning: async () => args.probe },
    tailscaled: args.tailscaled,
    threads: [{ threadId: args.threadId, conversationId: args.conversationId }],
    log: (message) => console.error(message),
  });
  await host.send(args.threadId, `bash: ${args.command}`, "msg:killed-mid-tool", "followUp");
  console.log("SENT");
}
