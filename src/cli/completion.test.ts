/**
 * `nexus completion`: each shell's script names the whole registry, and bash's, which runs here, completes commands,
 * flags and IDs through the real CLI on PATH, and nothing for IDs when the control plane is down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deadPort, tempDir } from "../test-support/kit.ts";
import { project, setup } from "../test-support/cli-kit.ts";
import { commands } from "./commands/index.ts";
import { shells } from "./completion.ts";

const shim = fileURLToPath(new URL("../../deploy/mac/nexus", import.meta.url));
const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (script: string, word: string) => new RegExp(`(^|[\\s"'(=])${escaped(word)}(?=[\\s"');]|$)`, "m").test(script);

test("each shell's script names every command, subcommand and flag the registry parses", async (t) => {
  const s = await setup(t);
  for (const shell of shells) {
    const { code, stdout: script, stderr } = await s.nexus(["completion", shell]);
    assert.equal(code, 0, stderr);
    const missing = Object.entries(commands).flatMap(([name, command]) => [
      ...name.split(" "), ...Object.keys(command.options ?? {}).map((option) => `--${option}`),
    ].filter((word) => !named(script, word)).map((word) => `${name}: ${word}`));
    assert.deepEqual(missing, [], shell);
    for (const flag of ["--json", "--url", "--socks", "--help"]) assert.ok(named(script, flag), `${shell}: ${flag}`);
  }
  assert.equal((await s.nexus(["completion", "powershell"])).stderr, "nexus: completion takes zsh, bash, fish, got powershell. Run nexus completion --help for usage\n");
});

test("bash completes commands, subcommands, flags, and the threads and projects the control plane lists", async (t) => {
  const s = await setup(t);
  const { id } = await s.json(["start", "--project", project.id, "--title", "x"]);
  const dir = await tempDir("nexus-completion-", t);
  await symlink(shim, join(dir, "nexus"));
  const script = join(dir, "nexus.bash");
  await writeFile(script, (await s.nexus(["completion", "bash"])).stdout);
  /** Completes at the end of `line`, given its words as readline breaks them, at spaces and around = and :. */
  const complete = (line: string, env = s.env(), prelude = "") => new Promise<{ words: string[]; stderr: string }>((resolve, reject) => {
    const words = line.split(" ").flatMap((word) => word.split(/(?=[=:])|(?<=[=:])/)).map((piece, i, all) => i === all.length - 1 && line.endsWith(" ") ? "" : piece);
    const run = `${prelude} source "$0"; COMP_LINE="$1"; COMP_POINT=\${#COMP_LINE}; shift; COMP_WORDS=("$@"); COMP_CWORD=$(($# - 1)); _nexus; printf '%s\\n' "\${COMPREPLY[@]}"`;
    const child = spawn("bash", ["-c", run, script, line, ...words], { env: { ...env, PATH: `${dir}:${env.PATH}` } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("error", reject).on("close", () => resolve({ words: stdout.split("\n").filter((w) => w !== "").sort(), stderr }));
  });

  assert.deepEqual((await complete("nexus thr")).words, ["thread", "threads"], "thread, the group of thread show, and threads");
  assert.deepEqual((await complete("nexus image roll")).words, ["rollback", "rollout"]);
  assert.deepEqual((await complete("nexus usage ")).words, ["backfill"], "a command that is also a group offers its subcommands");
  assert.deepEqual((await complete("nexus --json threads --needs")).words, ["--needs-me"]);
  assert.deepEqual((await complete("nexus show ")).words, ["@last", id]);
  assert.deepEqual((await complete("nexus send --steer ")).words, ["@last", id]);
  assert.deepEqual((await complete("nexus archive ")).words, ["@last", id], "a command that takes several threads completes them too");
  assert.deepEqual((await complete(`nexus show ${id} `)).words, [], "only the first argument is a thread");
  assert.deepEqual((await complete("nexus project edit ")).words, [project.id]);
  assert.deepEqual((await complete("nexus threads --project ")).words, [project.id]);
  assert.deepEqual((await complete("nexus events --thread ")).words, [id]);

  const down = s.env({ NEXUS_URL: `http://127.0.0.1:${await deadPort(t)}`, NEXUS_SOCKS: "none" });
  assert.deepEqual(await complete("nexus show ", down), { words: ["@last"], stderr: "" }, "an unreachable control plane completes no IDs, silently");
  assert.deepEqual((await complete("nexus sh", down)).words, ["show"]);
  const { NEXUS_URL: url, NEXUS_SOCKS: socks } = s.env();
  assert.deepEqual((await complete(`nexus --url=${url} --socks ${socks} show `, down)).words, ["@last", id], "the line's --url and --socks choose where the IDs come from");
  assert.deepEqual((await complete(`nexus --url="${url}" --socks '${socks}' show `, down)).words, ["@last", id], "a quoted --url and --socks reach the lookup unquoted");
  assert.deepEqual((await complete(`nexus --url=${url} sh`, down)).words, ["show"]);
  assert.deepEqual((await complete(`nexus send --file ${dir}/nexus.b`, s.env(), "enable -n compopt;")).words, [script], "a bash without compopt, as macOS's 3.2, completes a file flag's path");
  await mkdir(join(dir, "nexus review"));
  assert.deepEqual((await complete(`nexus send --file ${dir}/nexus`, s.env(), "enable -n compopt;")).words, [join(dir, "nexus"), join(dir, "nexus review"), script], "a path with a space stays one candidate");
  const registered = spawnSync("bash", ["-c", `enable -n compopt; source "$0"; complete -p nexus`, script], { encoding: "utf8" }).stdout;
  assert.match(registered, /-o filenames/, "without compopt the candidates are quoted and marked as file names");
});
