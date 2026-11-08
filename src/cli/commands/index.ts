/** Every command group, and the one table of commands the CLI runs, in the order `nexus --help` lists them. */

import { connectCommands } from "./connect.ts";
import { eventsCommands } from "./events.ts";
import { releaseCommands } from "./release.ts";
import { threadsCommands } from "./threads.ts";
import { watchCommands } from "./watch.ts";
import { itemsCommands } from "./items.ts";
import { projectsCommands } from "./projects.ts";
import { usageCommands } from "./usage.ts";
import { nodesCommands } from "./nodes.ts";
import { doctorCommands } from "./doctor.ts";
import type { Command } from "../kit.ts";

export const commandGroups: readonly Readonly<Record<string, Command>>[] = [connectCommands, eventsCommands, releaseCommands, threadsCommands, watchCommands, itemsCommands, projectsCommands, usageCommands, nodesCommands, doctorCommands];
const grouped: Readonly<Record<string, Command>> = Object.assign({}, ...commandGroups);
const order = [
  "connect", "events", "threads", "show", "ports", "preview", "unpreview", "files", "changes", "diff", "conversation", "session open", "session close", "attach",
  "start", "start-queued", "items", "item add", "item show", "item approve", "item cancel", "send", "watch", "seen",
  "abort", "retry", "retry-pylon", "wake", "archive", "unarchive", "delete", "projects", "project show", "project edit", "project add",
  "review", "land", "deploy", "release", "image build", "image rollout", "image rollback", "image list", "image current", "nodes", "node", "doctor", "usage", "usage backfill",
];
export const commands: Readonly<Record<string, Command>> = Object.fromEntries(order.map((name) => [name, grouped[name]!]));
