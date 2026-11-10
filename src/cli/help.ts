import { version } from "../version.ts";
import { configFile } from "./config.ts";
import { commands, sections } from "./commands/index.ts";
import type { Io } from "./kit.ts";

const entries = (names: readonly string[]) => [...new Set(names.map((name) => commands[name]!.help))].flat().join("\n");

export const usage = (env: Io["env"]) => `nexus ${version}, the Nexus control plane from this Mac

${sections.map((section) => `${section.title}\n${entries(section.names)}\n`).join("\n")}
Help
  nexus --help | -h | help [command]           these lines, or only a command's or a group's, as nexus <command> --help prints them
  nexus --version

Global flags
  Every command takes --json, --url URL and --socks HOST:PORT|none, before or after its name. The URL and proxy come
  from those flags, then NEXUS_URL and NEXUS_SOCKS, then ${configFile(env)}, which \`nexus connect\` writes.
  Without a proxy the CLI connects directly.
`;

/** A command's entry, or each entry of a group such as `image`, whose commands are `image build` and the rest. */
export const usageOf = (name: string) => `${entries(Object.keys(commands).filter((other) => other === name || other.startsWith(`${name} `)))}\n`;

/** A group's commands without the group's name, such as `build` of `image build`. */
export const subcommandsOf = (group: string) => Object.keys(commands).flatMap((name) => name.startsWith(`${group} `) ? [name.slice(group.length + 1)] : []);

/** The first word of each two-word command, such as `image` or `project`. */
export const groups: ReadonlySet<string> = new Set(Object.keys(commands).flatMap((name) => name.includes(" ") ? [name.split(" ")[0]!] : []));

/** The candidate within a third of `given`'s length in edits, counting a swap of two neighbours as one, if any is. */
export function nearest(given: string, candidates: Iterable<string>): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = edits(given, name);
    if (distance <= Math.max(1, Math.floor(given.length / 3)) && (best === undefined || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

function edits(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}
