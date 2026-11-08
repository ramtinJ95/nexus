import { execFileSync } from "node:child_process";

// bash -n reads the script alone and runs nothing, so only a complete script, one that cannot close the wrapper's `{`
// early, reaches the eval, which defines the function and runs none of its body.
const reprint = 'bash -n -c "$1" && eval "__script() {\n$1\n}" && declare -f __script';

/** A shell script as bash reads it: heredocs and strings kept, comments dropped, and its shebang ahead. Throws on a syntax error. */
export const shellReprint = (source: string) =>
  `${/^#!.*/.exec(source)?.[0] ?? ""}\n${execFileSync("bash", ["-c", reprint, "_", source], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })}`;
