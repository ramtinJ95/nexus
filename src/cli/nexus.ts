/**
 * The Mac's nexus CLI: the control plane's API as commands, for a human at a shell and for the Claude Code and pi
 * integrations, which shell out to it. docs/cli.md is the contract: the commands, their JSON, the exit codes and
 * the watch stream. --json prints the API's reply as it is, except where docs/cli.md says otherwise.
 */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { call, CliError, exitCodes, follow, upgrade, type Endpoint } from "./transport.ts";
import { version } from "../version.ts";
import type { Values } from "./kit.ts";
import { settings, checked } from "./config.ts";
import { usage, usageOf } from "./help.ts";
import { commands } from "./commands/index.ts";

const globalOptions: ParseArgsOptionsConfig = {
  json: { type: "boolean" }, url: { type: "string" }, socks: { type: "string" }, help: { type: "boolean", short: "h" },
};

/** The exit code a command that printed its result asks for, 0 for most. */
async function run(argv: readonly string[]): Promise<number> {
  // `project add` and `session open` and `close` are the commands of two words.
  const twoWords = Object.hasOwn(commands, `${argv[0]} ${argv[1]}`);
  const name = twoWords ? `${argv[0]} ${argv[1]}` : argv[0];
  const rest = argv.slice(twoWords ? 2 : 1);
  const command = Object.hasOwn(commands, name!) ? commands[name!]! : undefined;
  if (command === undefined) throw new CliError("invalid", argv.length === 0 ? "no command given" : `unknown command ${name}`);
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...rest], options: { ...command.options, ...globalOptions }, allowPositionals: true, strict: true }) as typeof parsed;
  } catch (err) {
    throw new CliError("invalid", (err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    process.stdout.write(usageOf(name!));
    return 0;
  }
  const [min, max] = command.args;
  if (positionals.length < min || positionals.length > max) {
    throw new CliError("invalid", `${name} takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} argument${max === 1 ? "" : "s"}, got ${positionals.length}`);
  }
  // Only once a command calls the API, since connect sets the URL rather than reading it. A failed health read is
  // not kept, so a watch's next try reads it again.
  let target: Promise<Endpoint> | undefined;
  const endpoint = () => target ??= settings(values).then(checked).catch((err: unknown) => { target = undefined; throw err; });
  const result = await command.run(async (method, path, body, idleMs) => call(await endpoint(), method, path, body, idleMs), positionals, values,
    async (path, onEvent, signal, onCursor) => follow(await endpoint(), path, onEvent, signal, onCursor), { connect: async (path) => upgrade(await endpoint(), path) });
  if (result === undefined) return 0;
  process.stdout.write(`${values.json === true ? JSON.stringify(result.json, null, 2) : result.text}\n`);
  return result.exit === undefined ? 0 : exitCodes[result.exit];
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "version") {
    process.stdout.write(`nexus ${version}\n`);
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(usage);
    return 0;
  }
  try {
    return await run(argv);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    const json = argv.includes("--json");
    process.stderr.write(json ? `${JSON.stringify({ error: err.message, kind: err.kind, status: err.status, code: err.code })}\n`
      : argv.length === 0 ? usage : `nexus: ${err.message}${err.kind === "invalid" && err.status === null ? ". Run nexus --help for usage" : ""}\n`);
    return exitCodes[err.kind];
  }
}

process.exitCode = await main(process.argv.slice(2));
