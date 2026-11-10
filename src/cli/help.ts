import { version } from "../version.ts";
import { configFile } from "./config.ts";
import { commands } from "./commands/index.ts";
import type { Io } from "./kit.ts";

export const usage = (env: Io["env"]) => `nexus ${version}, the Nexus control plane from this Mac

${[...new Set(Object.values(commands).map((command) => command.help))].flat().join("\n")}
  nexus --version

Every command takes --json, --url URL and --socks HOST:PORT|none. The URL and proxy come from those flags,
then NEXUS_URL and NEXUS_SOCKS, then ${configFile(env)}, which \`nexus connect\` writes. Without a proxy the CLI
connects directly.
`;

export function usageOf(name: string): string {
  const named = Object.entries(commands).filter(([other]) => other === name || other.startsWith(`${name} `));
  return `${[...new Set(named.map(([, command]) => command.help))].flat().join("\n")}\n`;
}
