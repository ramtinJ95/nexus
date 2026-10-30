/** `nexus events`: the control plane's events, once or followed. */
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { NexusEvent } from "../../events.ts";
import { CliError } from "../transport.ts";
import { type Command, str, strs, untilConsumerGone } from "../kit.ts";
import { transient } from "../config.ts";

export const eventsCommands: Readonly<Record<string, Command>> = {
  events: {
    args: [0, 0],
    options: { follow: { type: "boolean" }, since: { type: "string" }, thread: { type: "string" }, project: { type: "string" }, kind: { type: "string", multiple: true } },
    async run(api, _, v, follow) {
      const query = new URLSearchParams();
      for (const key of ["since", "thread", "project"]) if (str(v, key) !== undefined) query.set(key, str(v, key)!);
      for (const kind of strs(v, "kind")) query.append("kind", kind);
      const print = async (event: NexusEvent, signal?: AbortSignal) => {
        const line = v.json ? JSON.stringify(event) : `${event.id} ${new Date(event.time).toISOString()} ${event.thread ?? "-"} ${event.kind} ${JSON.stringify(event.payload)}`;
        if (!process.stdout.write(line + "\n")) await once(process.stdout, "drain", { signal });
        query.set("since", event.id);
      };
      if (v.follow !== true) {
        for (const event of await api("GET", `/v1/events?${query}`) as NexusEvent[]) await print(event);
        return;
      }
      query.set("follow", "true");
      const stop = new AbortController();
      const dispose = untilConsumerGone(() => { stop.abort(); process.exit(0); });
      try {
        while (!stop.signal.aborted) {
          try { await follow(`/v1/events?${query}`, (data) => print(data as NexusEvent, stop.signal), stop.signal, (id) => query.set("since", id)); }
          catch (err) {
            if (err instanceof CliError && !transient(err)) throw err;
            if (!stop.signal.aborted) console.error(`nexus: ${(err as Error).message}; reconnecting`);
          }
          await sleep(1000, undefined, { signal: stop.signal }).catch(() => undefined);
        }
      } finally {
        dispose();
      }
    },
  },
};
