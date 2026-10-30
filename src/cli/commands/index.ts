/** Every command group, and the one table of commands the CLI runs. */

import { connectCommands } from "./connect.ts";
import { eventsCommands } from "./events.ts";
import { releaseCommands } from "./release.ts";
import { threadsCommands } from "./threads.ts";
import { watchCommands } from "./watch.ts";
import { itemsCommands } from "./items.ts";
import { projectsCommands } from "./projects.ts";
import { usageCommands } from "./usage.ts";
import { nodesCommands } from "./nodes.ts";
import type { Command } from "../kit.ts";

export const commandGroups: readonly Readonly<Record<string, Command>>[] = [connectCommands, eventsCommands, releaseCommands, threadsCommands, watchCommands, itemsCommands, projectsCommands, usageCommands, nodesCommands];
export const commands: Readonly<Record<string, Command>> = Object.assign({}, ...commandGroups);
