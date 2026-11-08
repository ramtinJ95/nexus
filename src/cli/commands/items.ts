/** The pipeline items: `items` and the `item` commands. */
import type { PipelineItem } from "../../control/pipeline.ts";
import { CliError } from "../transport.ts";
import { type Command, str, request, workerOptions, briefOf, ago, table, clip } from "../kit.ts";
import { itemRoutes } from "../../contract/projects.ts";

const itemRow = (i: PipelineItem) => [i.id, i.phase.kind, i.phase.why, i.thread ?? "no thread yet", i.project, ago(i.addedAt), i.title];

function itemText(i: PipelineItem): string {
  return [
    `${i.id}  ${i.title}`,
    `project: ${i.project}`,
    `phase: ${i.phase.kind}, ${i.phase.why}`,
    `thread: ${i.thread ?? "none yet"}`,
    `worker: ${i.worker === "claude" ? `Claude worker, model ${i.model ?? "unknown"}` : "Nexus agent"}`,
    ...i.after.map((id) => `after: ${id}`),
    ...i.brief === null ? [] : [`brief: ${clip(i.brief.split("\n").find((line) => line.trim() !== "")?.trim() ?? "", 120)}`],
    `added by ${i.addedBy} ${ago(i.addedAt)}`,
    ...i.approved === null ? [] : [`approved by ${i.approved.by} ${ago(i.approved.at)}`],
    ...i.thread === null ? [] : [`nexus show ${i.thread} shows its thread.`],
  ].join("\n");
}

export const itemsCommands: Readonly<Record<string, Command>> = {
  items: {
    help: ["  nexus items [--project P] [--all]            pipeline items and the phase each is in; cancelled ones only with --all"],
    args: [0, 0],
    options: { project: { type: "string" }, all: { type: "boolean" } },
    async run(api, _, v) {
      const items = await request(api, itemRoutes.list, { query: { project: str(v, "project"), ...v.all === true ? {} : { cancelled: false } } });
      return { json: items, text: items.length === 0 ? "No pipeline items." : table(items.map(itemRow)) };
    },
  },
  "item add": {
    help: [
      "  nexus item add --project P [--title T] (--message M | --claude PROMPT [--model ID]) [--after ITEM[,ITEM...]]",
      "                 [--node N|auto] [--branch B] [--commit C] [--cpus n] [--memory GiB] [--disk GiB]",
      "    an item becomes a queued thread once the items it is after are, and starts once their pull requests merge",
    ],
    args: [0, 0],
    options: workerOptions,
    async run(api, _, v) {
      const { project, title, optional, resources, after } = briefOf(v, "item add");
      if (v.message === undefined && v.claude === undefined) throw new CliError("invalid", "item add needs a brief: --message, or --claude for a Claude worker");
      const i = await request(api, itemRoutes.add, { body: { project, title: title!, ...optional, ...resources === undefined ? {} : { resources }, ...after === undefined ? {} : { after } } });
      return { json: i, text: `Added ${i.id} to ${i.project}: ${i.title}. It is ${i.phase.kind}: ${i.phase.why}.` };
    },
  },
  "item show": {
    help: ["  nexus item show <item>                       an item with its phase, its thread and its brief"],
    args: [1, 1],
    async run(api, [id]) {
      const i = await request(api, itemRoutes.show, { item: id! });
      return { json: i, text: itemText(i) };
    },
  },
  "item approve": {
    help: ["  nexus item approve <item>                    let an item become a thread, in a project whose pipeline waits for approval"],
    args: [1, 1],
    async run(api, [id]) {
      const i = await request(api, itemRoutes.approve, { item: id! });
      return { json: i, text: `Approved ${i.id}. It is ${i.phase.kind}: ${i.phase.why}.` };
    },
  },
  "item cancel": {
    help: ["  nexus item cancel <item>                     an item that is not a thread yet, which then never becomes one"],
    args: [1, 1],
    async run(api, [id]) {
      const i = await request(api, itemRoutes.cancel, { item: id! });
      return { json: i, text: `Cancelled ${i.id}. It will never become a thread.` };
    },
  },
};
