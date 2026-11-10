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
import { questionsCommands } from "./questions.ts";
import { completionCommands } from "./completion.ts";
import type { Command } from "../kit.ts";

export const commandGroups: readonly Readonly<Record<string, Command>>[] = [connectCommands, eventsCommands, releaseCommands, threadsCommands, watchCommands, itemsCommands, projectsCommands, usageCommands, nodesCommands, doctorCommands, questionsCommands, completionCommands(() => commands)];
const grouped: Readonly<Record<string, Command>> = Object.assign({}, ...commandGroups);
/** nexus --help lists the commands under these headers, in this order. */
export const sections: readonly { title: string; names: readonly string[] }[] = [
  { title: "Setup", names: ["connect", "doctor", "completion"] },
  { title: "Threads", names: ["threads", "show", "ports", "preview", "unpreview", "files", "changes", "diff", "conversation", "session open", "session close", "attach"] },
  { title: "Work", names: ["start", "start-queued", "send", "answer", "watch", "seen", "abort", "retry", "retry-pylon", "wake", "archive", "unarchive", "delete"] },
  { title: "Pipeline", names: ["items", "item add", "item show", "item approve", "item cancel"] },
  { title: "Projects", names: ["projects", "project show", "project edit", "project add"] },
  { title: "Review and release", names: ["review", "land", "deploy", "release"] },
  { title: "Images", names: ["image build", "image rollout", "image rollback", "image list", "image current"] },
  { title: "Nodes, events and usage", names: ["nodes", "node", "events", "usage", "usage backfill"] },
];
export const commands: Readonly<Record<string, Command>> = Object.fromEntries(sections.flatMap((section) => section.names).map((name) => [name, grouped[name]!]));
