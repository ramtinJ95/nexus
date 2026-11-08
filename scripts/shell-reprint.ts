import { execFileSync } from "node:child_process";

// bash -n reads the script alone and runs nothing, so only a complete script, one that cannot close the wrapper's `{`
// early, reaches the eval, which defines the function and runs none of its body.
const reprint = 'bash -n -c "$1" && eval "__script() {\n$1\n}" && declare -f __script';

/**
 * A shell script's lines without its whole-line comments, and bash's reprint of it. The lines keep what bash
 * normalizes away, such as `function f` against `f()`, which `sh` refuses, and the line breaks alias expansion reads.
 * The reprint keeps the `#` lines of heredocs and strings, which are data. A comment after a `\` continuation joins
 * its command, so it stays in the lines, and so does a trailing comment. Throws on a syntax error.
 */
export const shellReprint = (source: string) => {
  // An alias can expand to a heredoc's start, which neither the lines nor the reprint see, so neither proves anything.
  if (/\balias\b/.test(source)) throw new Error("it names alias, which this check cannot follow");
  const lines = source.split("\n").filter((line, at, all) => (at === 0 && line.startsWith("#!")) || !/^[ \t]*#/.test(line) || all[at - 1]?.endsWith("\\"));
  return `${lines.join("\n")}\n${execFileSync("bash", ["-c", reprint, "_", source], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })}`;
};
