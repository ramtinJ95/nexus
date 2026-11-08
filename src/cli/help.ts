/** The CLI's help text, whole for --help and by command for each command's --help, from each command's `help`. */
import { version } from "../version.ts";
import { configFile } from "./config.ts";
import { commands } from "./commands/index.ts";

export const usage = `nexus ${version}, the Nexus control plane from this Mac

${[...new Set(Object.values(commands).map((command) => command.help))].flat().join("\n")}
  nexus --version

Every command takes --json, --url URL and --socks HOST:PORT|none. The URL and proxy come from those flags,
then NEXUS_URL and NEXUS_SOCKS, then ${configFile()}, which \`nexus connect\` writes. Without a proxy the CLI
connects directly.
`;

/** The help of the command and of the commands it is the first word of, as `usage backfill` is of `usage`. */
export function usageOf(name: string): string {
  const named = Object.entries(commands).filter(([other]) => other === name || other.startsWith(`${name} `));
  return `${[...new Set(named.map(([, command]) => command.help))].flat().join("\n")}\n`;
}
