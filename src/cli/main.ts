/**
 * The Mac's nexus CLI, which nexus.ts runs: the control plane's API as commands, for a human at a shell and for the
 * Claude Code and pi integrations, which shell out to it. docs/cli.md is the contract: the commands, their JSON, the
 * exit codes and the watch stream. --json prints the API's reply as it is, except where docs/cli.md says otherwise.
 */
import { parseArgs } from "node:util";
import { call, CliError, exitCodes, follow, upgrade, UsageError, type Endpoint } from "./transport.ts";
import { version } from "../version.ts";
import { globalOptions, noteTo, ridingRestarts, type Api, type Io, type Values } from "./kit.ts";
import { threadOf } from "./refs.ts";
import { settings, checked } from "./config.ts";
import { groups, nearest, subcommandsOf, usage, usageOf } from "./help.ts";
import { commands } from "./commands/index.ts";

/**
 * What a run asks for, read from its words before a command parses its flags. `help` with `asked` false is a run
 * that named no command, or only a group such as `image`, and gets that help on stderr as a failure.
 */
type Invocation =
  | { to: "version" }
  | { to: "help"; of: string | null; asked: boolean }
  | { to: "command"; name: string; args: string[] }
  | { to: "unknown"; name: string; group: string | null };

const isHelp = (word: string) => word === "--help" || word === "-h";

/** Global flags may come before the command, and then go to it as if they followed its name. */
function invocationOf(argv: readonly string[]): Invocation {
  const leading: string[] = [];
  let at = 0;
  for (; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "--url" || word === "--socks") {
      leading.push(word, ...argv.slice(at + 1, at + 2));
      at++;
    } else if (word === "--json" || word === "--version" || isHelp(word) || /^--(url|socks)=/.test(word)) leading.push(word);
    else break;
  }
  const words = argv.slice(at);
  if (leading.includes("--version") || words[0] === "version") return { to: "version" };
  if (words[0] === "help") return words.length === 1 ? { to: "help", of: null, asked: true } : invocationOf([...leading, "--help", ...words.slice(1)]);
  const asked = leading.some(isHelp);
  const [first, second] = words;
  const flags = words.slice(1, words.includes("--") ? words.indexOf("--") : undefined);
  if (first === undefined) return { to: "help", of: null, asked };
  for (const name of [`${first} ${second}`, first]) {
    if (Object.hasOwn(commands, name)) return { to: "command", name, args: [...leading, ...words.slice(name.split(" ").length)] };
  }
  if (!groups.has(first)) return { to: "unknown", name: first, group: null };
  if (second === undefined || second.startsWith("-")) return { to: "help", of: first, asked: asked || flags.some(isHelp) };
  return { to: "unknown", name: `${first} ${second}`, group: first };
}

function unknown({ name, group }: { name: string; group: string | null }): UsageError {
  if (name.startsWith("-")) return new UsageError(`unknown flag ${name}, since before a command nexus takes only --json, --url, --socks, --help and --version`);
  const near = group === null ? nearest(name, new Set(Object.keys(commands).map((other) => other.split(" ")[0]!))) : nearest(name.slice(group.length + 1), subcommandsOf(group));
  return new UsageError(`unknown command ${name}${near === undefined ? "" : `. Did you mean ${group === null ? "" : `${group} `}${near}?`}`);
}

async function run(invocation: Invocation, io: Io, json: boolean): Promise<number> {
  switch (invocation.to) {
    case "version":
      io.stdout.write(`nexus ${version}\n`);
      return 0;
    case "unknown":
      throw unknown(invocation);
    case "help": {
      const text = invocation.of === null ? usage(io.env) : usageOf(invocation.of);
      if (invocation.asked) {
        io.stdout.write(text);
        return 0;
      }
      if (json) throw new UsageError(invocation.of === null ? "no command given" : `${invocation.of} takes a command: ${subcommandsOf(invocation.of).join(", ")}`);
      io.stderr.write(text);
      return exitCodes.invalid;
    }
    case "command":
      return await runCommand(invocation.name, invocation.args, io);
  }
}

async function runCommand(name: string, args: readonly string[], io: Io): Promise<number> {
  const command = commands[name]!;
  const options = { ...command.options, ...globalOptions };
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true }) as typeof parsed;
  } catch (err) {
    const { code, message } = err as Error & { code?: string };
    const flag = /'([^']+)'/.exec(message)?.[1];
    // Node's own words for a value that starts with a dash, such as --message "--force is broken".
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && flag !== undefined && message.includes("argument is ambiguous")) {
      const file = Object.hasOwn(options, `${flag.slice(2)}-file`) ? `, or from a file or stdin with ${flag}-file PATH|-` : "";
      throw new UsageError(`${flag} takes a value that starts with a dash only as ${flag}=VALUE${file}`);
    }
    if (code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION" || flag === undefined) throw new UsageError(message);
    const near = flag.startsWith("--") ? nearest(flag.slice(2), Object.keys(options)) : undefined;
    throw new UsageError(`${name} takes no ${flag.trim()}${near === undefined ? "" : `. Did you mean --${near}?`}${command.dashHint === undefined ? "" : `${near === undefined ? "." : ""} ${command.dashHint}.`}`);
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    io.stdout.write(usageOf(name));
    return 0;
  }
  const [min, max] = command.args;
  if (positionals.length < min || positionals.length > max) {
    throw new UsageError(`${name} takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} argument${max === 1 ? "" : "s"}, got ${positionals.length}`);
  }
  // Only once a command calls the API, since connect sets the URL rather than reading it. A failed health read is
  // not kept, so a watch's next try reads it again.
  let target: ReturnType<typeof checked> | undefined;
  const note = noteTo(io.stderr);
  const read = () => target ??= settings(values, io.env).then((at) => checked(at, command.anyVersion === true, note)).catch((err: unknown) => { target = undefined; throw err; });
  const endpoint = async (): Promise<Endpoint> => (await read()).endpoint;
  const api: Api = ridingRestarts(async (method, path, body, idleMs) => call(await endpoint(), method, path, body, idleMs), note);
  if (command.thread === true) positionals[0] = await threadOf(api, positionals[0]!);
  const result = await command.run(api, positionals, values,
    async (path, onEvent, signal, onCursor) => follow(await endpoint(), path, onEvent, signal, onCursor), { connect: async (path) => upgrade(await endpoint(), path), versions: async () => (await read()).versions, io });
  if (result === undefined) return 0;
  if (typeof result === "number") return result;
  io.stdout.write(`${values.json === true ? JSON.stringify(result.json, null, 2) : result.text}\n`);
  return result.exit === undefined ? 0 : exitCodes[result.exit];
}

/**
 * One run of the CLI, which returns its exit code. Tests call it in their own process with streams and an environment
 * of their own. attach and --rules-file - still read the process's own terminal and stdin, and a start without
 * --project the process's working directory.
 */
export async function main(argv: readonly string[], io: Io = process): Promise<number> {
  const invocation = invocationOf(argv);
  const json = argv.includes("--json");
  try {
    return await run(invocation, io, json);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    const of = invocation.to === "command" ? `${invocation.name} ` : invocation.to === "unknown" && invocation.group !== null ? `${invocation.group} ` : "";
    const pointer = err instanceof UsageError ? `${/[.?]$/.test(err.message) ? "" : "."} Run nexus ${of}--help for usage` : "";
    io.stderr.write(json ? `${JSON.stringify({ error: err.message, kind: err.kind, status: err.status, code: err.code })}\n` : `nexus: ${err.message}${pointer}\n`);
    return exitCodes[err.kind];
  }
}
