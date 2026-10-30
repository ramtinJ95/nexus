/** POSIX shell quoting, for commands Nexus runs in a pylon or on a node. */
import { posix } from "node:path";

export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A shell command that installs `source` at `path` with `owner`, the owner's group and `mode`. Missing parents are
 * made as the owner, so a user's file never lands in a directory only root can write.
 */
export function installFileCommand(path: string, owner: string, mode: number, source: string): string {
  const user = shellQuote(owner);
  const dir = shellQuote(posix.dirname(path));
  const mkdir = owner === "root" ? `mkdir -p ${dir}` : `runuser -u ${user} -- mkdir -p ${dir}`;
  return `${mkdir} && install -o ${user} -g "$(id -gn ${user})" -m ${mode.toString(8)} ${shellQuote(source)} ${shellQuote(path)}`;
}
