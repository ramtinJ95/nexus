import type { Command } from "../kit.ts";
import { UsageError } from "../transport.ts";
import { completionScript, shells } from "../completion.ts";

/** `registry` gives the commands the script completes, this one among them, once they are all registered. */
export const completionCommands = (registry: () => Readonly<Record<string, Command>>): Readonly<Record<string, Command>> => ({
  completion: {
    help: ["  nexus completion zsh|bash|fish               a script that completes this CLI's commands, flags, threads and projects"],
    args: [1, 1],
    async run(_api, [shell]) {
      if (!shells.includes(shell as never)) throw new UsageError(`completion takes ${shells.join(", ")}, got ${shell}`);
      const script = completionScript(shell as (typeof shells)[number], registry());
      return { json: { shell, script }, text: script.trimEnd() };
    },
  },
});
