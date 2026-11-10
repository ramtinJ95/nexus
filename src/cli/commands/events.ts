import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { CliError } from "../transport.ts";
import { type Command, reconnectMs, request, str, strs, untilConsumerGone, when } from "../kit.ts";
import { callOf } from "../../contract/route.ts";
import { streamRoutes, type EventsQuery, type NexusEvent } from "../../contract/streams.ts";
import { transient } from "../config.ts";

export const eventsCommands: Readonly<Record<string, Command>> = {
  events: {
    help: ["  nexus events [--follow] [--since ID] [--thread T] [--project P] [--kind K]..."],
    args: [0, 0],
    options: { follow: { type: "boolean" }, since: { type: "string" }, thread: { type: "string" }, project: { type: "string" }, kind: { type: "string", multiple: true } },
    async run(api, _, v, follow, { io }) {
      const query: EventsQuery = { since: str(v, "since"), thread: str(v, "thread"), project: str(v, "project"), kinds: strs(v, "kind") };
      const print = async (event: NexusEvent, signal?: AbortSignal) => {
        const line = v.json ? JSON.stringify(event) : `${event.id} ${when(event.time)} ${event.thread ?? "-"} ${event.kind} ${JSON.stringify(event.payload)}`;
        if (!io.stdout.write(line + "\n")) await once(io.stdout, "drain", { signal });
        query.since = event.id;
      };
      if (v.follow !== true) {
        for (const event of await request(api, streamRoutes.events, { query }) as NexusEvent[]) await print(event);
        return;
      }
      query.follow = true;
      const stop = new AbortController();
      const dispose = untilConsumerGone(() => { stop.abort(); process.exit(0); });
      try {
        for (let failed = 0; !stop.signal.aborted; failed++) {
          const read = (data: unknown) => { failed = 0; return print(data as NexusEvent, stop.signal); };
          try { await follow(callOf(streamRoutes.events, { query }).path, read, stop.signal, (id) => { query.since = id; }); }
          catch (err) {
            if (err instanceof CliError && !transient(err)) throw err;
            if (!stop.signal.aborted) io.stderr.write(`nexus: ${(err as Error).message}; reconnecting\n`);
          }
          await sleep(reconnectMs(failed), undefined, { signal: stop.signal }).catch(() => undefined);
        }
      } finally {
        dispose();
      }
    },
  },
};
