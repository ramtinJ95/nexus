/**
 * Test support for src/harness/slice.test.ts. A scripted model that needs no network: a user message
 * `bash: <command>` becomes one bash tool call, `tool: <name> <JSON arguments>` one call of that tool, and a tool result
 * becomes a short final answer. A user message
 * `stream: <n>` is answered `word0 word1 ...` up to n words, written one word every 20 ms, as a model streams. Every
 * answer reports `scriptedUsage`.
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
/** What each scripted answer reports it used. */
export const scriptedUsage = { input: 1_234, output: 56, cacheWrite: 890, cacheRead: 7_000 } as const;
/** How often a streamed answer gets its next word. */
export const streamedWordMs = 20;
export const streamedAnswer = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ");

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
      const tool = last.role === "user" ? /^tool: (\S+) ([\s\S]*)$/.exec(text(last)) : null;
      const call = command !== undefined ? { name: "bash", arguments: { command, timeout: 600 } } : tool ? { name: tool[1]!, arguments: JSON.parse(tool[2]!) } : undefined;
      const streamed = last.role === "user" ? /^stream: (\d+)$/.exec(text(last))?.[1] : undefined;
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: call === undefined ? "stop" : "toolUse",
        usage: { ...scriptedUsage, totalTokens: 9_180, cost: { ...model.cost, total: 0 } },
        content: call === undefined
          ? [{ type: "text", text: `scripted answer after ${last.role}` }]
          : [{ type: "toolCall", id: `call-${input.messages.length}`, ...call }],
      };
      const stream = new AssistantMessageEventStream();
      if (streamed === undefined) {
        stream.push({ type: "done", reason: message.stopReason, message } as never);
        return stream;
      }
      const words = streamedAnswer(Number(streamed)).split(" ");
      const part = { type: "text", text: "" };
      const partial = { ...message, content: [part] };
      stream.push({ type: "start", partial: { ...message, content: [] } } as never);
      stream.push({ type: "text_start", contentIndex: 0, partial } as never);
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) {
          const delta = `${i === 0 ? "" : " "}${words[i++]}`;
          part.text += delta;
          stream.push({ type: "text_delta", contentIndex: 0, delta, partial } as never);
          return;
        }
        clearInterval(timer);
        stream.push({ type: "text_end", contentIndex: 0, content: part.text, partial } as never);
        stream.push({ type: "done", reason: "stop", message: partial } as never);
      }, streamedWordMs);
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
    threads: [{ threadId: args.threadId, conversationId: args.conversationId, agentTurnRunning: false }],
    deleted: [],
    onActivity: () => {},
    log: (message) => console.error(message),
  });
  await host.send(args.threadId, `bash: ${args.command}`, "msg:killed-mid-tool", "followUp");
  console.log("SENT");
}
