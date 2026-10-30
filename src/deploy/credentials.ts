/**
 * Gives the agents their credentials for `deploy/install.sh`, as `node src/deploy/setup.ts credentials`, after the
 * role installers ran. It asks only for what this machine lacks, and leaves every credential it finds as it is. In a
 * terminal it asks the person, and otherwise it reads the answers from NEXUS_* variables, so it never waits on input.
 * It prints what the installer must do next on stdout, one word a line, and everything else on stderr.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Who a credential serves. Every credential serves the whole install today. */
export type Scope = "install";

export interface Store {
  scope: Scope;
  /** The machines that keep one: the control plane's machine, or every machine, each with its own. */
  machines: "control" | "every";
  file: string;
  owner: string;
  mode: number;
}

/**
 * Where each kind of credential lives and whom it serves. This is the one place a per-person mode would change: it
 * would give a kind a store of scope "person" beside this one, so a shared install keeps its files where they are.
 * A file here is the default a new install gets. Where an existing config names its own, `locations` reads that.
 */
export const stores = {
  harness: { scope: "install", machines: "control", file: "/var/lib/nexus-control/harness-credentials.json", owner: "nexus-control:nexus-control", mode: 0o600 },
  claude: { scope: "install", machines: "every", file: "/etc/nexus/secrets.env", owner: "root:nexus", mode: 0o640 },
  githubWatch: { scope: "install", machines: "control", file: "/etc/nexus/github-token", owner: "root:nexus-control", mode: 0o640 },
  gitKey: { scope: "install", machines: "every", file: "/etc/nexus/git_ed25519", owner: "nexus:nexus", mode: 0o400 },
} as const satisfies Record<string, Store>;

export const claudeNames = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
export const gitKnownHosts = "/etc/nexus/git_known_hosts";
const controlConfig = "/etc/nexus/control.json";
const probeConfig = "/etc/nexus/probe.json";
const login = "/opt/nexus/control-current/src/control/login.ts";

/** GitHub's published SSH host key fingerprints, https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints */
const githubFingerprints: ReadonlySet<string> = new Set([
  "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
  "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
  "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
]);

/** Whether a harness credentials file holds a login. Throws when it is not JSON. */
export function harnessSignedIn(text: string): boolean {
  return Object.keys((JSON.parse(text) as { credentials?: object }).credentials ?? {}).length > 0;
}

/** The names in a secrets.env, never their values. */
export function secretNames(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? []);
}

/** ssh-keyscan's output, refused unless it has keys and every key is one GitHub publishes. */
export function githubHostKeys(scan: string): string {
  const lines = scan.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
  if (lines.length === 0) throw new Error("ssh-keyscan found no keys for github.com");
  for (const line of lines) {
    const [, type, key] = line.trim().split(/\s+/);
    const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(key ?? "", "base64")).digest("base64").replace(/=+$/, "")}`;
    if (!githubFingerprints.has(fingerprint)) throw new Error(`github.com offered the ${type} key ${fingerprint}, which is not one GitHub publishes`);
  }
  return lines.map((line) => `${line.trim()}\n`).join("");
}

const token = (value: string) => /^[\x21-\x7e]+$/.test(value) ? undefined : "a token is one line of printable characters with no spaces";
const githubToken = (value: string) => /^[A-Za-z0-9_]+$/.test(value) ? undefined : "a GitHub token is letters, digits and underscores";

export interface Question {
  /** The variable that answers it without a terminal. */
  key: string;
  say: string;
}
export interface Choice {
  id: string;
  label: string;
  /** Only a person at a terminal can take it, such as a browser login. */
  terminal?: boolean;
}

export interface Answers {
  /** The value, or undefined to skip it. `check` says what is wrong with a value, if anything. */
  secret(question: Question & { check: (value: string) => string | undefined }): Promise<string | undefined>;
  /** A choice's ID. The first choice is the default, and `unattended` the answer without a terminal. */
  choose(question: Question & { choices: readonly Choice[]; unattended: string }): Promise<string>;
}

/** Answers from the environment: `NAME`, or the file `NAME_FILE` names. A bad value fails rather than being skipped. */
export function scripted(env: NodeJS.ProcessEnv): Answers {
  const value = async (key: string) => {
    if (env[key]) return env[key];
    const file = env[`${key}_FILE`];
    return file ? (await readFile(file, "utf8")).trim() : undefined;
  };
  return {
    async secret({ key, check }) {
      const answer = await value(key);
      const wrong = answer === undefined ? undefined : check(answer);
      if (wrong !== undefined) throw new Error(`${key}: ${wrong}`);
      return answer;
    },
    async choose({ key, choices, unattended }) {
      const answer = await value(key) ?? unattended;
      const open = choices.filter((c) => !c.terminal);
      if (!open.some((c) => c.id === answer)) throw new Error(`${key} is ${answer}, and without a terminal must be one of ${open.map((c) => c.id).join(", ")}`);
      return answer;
    },
  };
}

/** Reads one line from the terminal, echoing it unless `hidden`. */
function readLine(prompt: string, hidden: boolean): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((done) => {
    let line = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      done(line);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stderr.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          if (line !== "" && !hidden) stderr.write("\b \b");
          line = line.slice(0, -1);
        } else if (char >= " ") {
          line += char;
          if (!hidden) stderr.write(char);
        }
      }
    };
    stdin.on("data", onData);
  });
}

export function terminal(): Answers {
  return {
    async secret({ say, check }) {
      for (;;) {
        const answer = (await readLine(`${say} `, true)).trim();
        if (answer === "") return undefined;
        const wrong = check(answer);
        if (wrong === undefined) return answer;
        console.error(`That is not it: ${wrong}. Try again, or press Enter to skip.`);
      }
    },
    async choose({ say, choices }) {
      console.error(say);
      choices.forEach((c, i) => console.error(`  ${i + 1}. ${c.label}${i === 0 ? " (the default)" : ""}`));
      for (;;) {
        const answer = (await readLine(`Choose 1 to ${choices.length}: `, false)).trim();
        if (answer === "") return choices[0]!.id;
        const chosen = choices[Number(answer) - 1] ?? choices.find((c) => c.id === answer);
        if (chosen !== undefined) return chosen.id;
      }
    },
  };
}

/** The machine, as root. Tests give a temporary directory instead. */
export interface Host {
  read(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
  /** Replaces the file with `text` through a temporary file, with the store's mode and owner. */
  write(path: string, text: string, store: { mode: number; owner: string }): Promise<void>;
  /** Adds to the end of an existing file, keeping its mode and owner. */
  append(path: string, text: string): Promise<void>;
  /** Gives a file a command made the store's mode and owner. */
  own(path: string, store: { mode: number; owner: string }): Promise<void>;
  /** Runs a command and returns its stdout, or with `interactive` gives it the terminal, its stdout going to stderr. */
  run(program: string, args: readonly string[], options?: { interactive?: boolean }): Promise<string>;
}

/** Through the open file rather than its path, so an owner of the directory cannot swap in a symlink first. */
async function ownOpen(file: FileHandle, { mode, owner }: { mode: number; owner: string }): Promise<void> {
  const [user, group] = owner.split(":");
  const uid = Number((await exec("id", ["-u", user!])).stdout);
  const gid = Number((await exec("getent", ["group", group!])).stdout.split(":")[2]);
  await file.chown(uid, gid);
  await file.chmod(mode);
}

export const system: Host = {
  read: (path) => readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }),
  exists: (path) => access(path).then(() => true, () => false),
  async write(path, text, { mode, owner }) {
    const temporary = `${path}.${process.pid}.tmp`;
    await rm(temporary, { force: true });
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      await ownOpen(file, { mode, owner });
      await file.writeFile(text);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  },
  append: (path, text) => appendFile(path, text),
  async own(path, store) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await ownOpen(file, store);
    } finally {
      await file.close();
    }
  },
  async run(program, args, options) {
    if (!options?.interactive) return (await exec(program, [...args], { maxBuffer: 1024 * 1024 })).stdout;
    const child = spawn(program, args, { stdio: ["inherit", 2, "inherit"] });
    const code = await new Promise<number | null>((done, failed) => child.on("error", failed).on("exit", done));
    if (code !== 0) throw new Error(`${program} exited with ${code}`);
    return "";
  },
};

export interface Locations { harness: string; secrets: string; gitKey: string; githubWatch: string | undefined; node: string | undefined }

/** Where this machine's credentials are: what control.json and probe.json name, or else the stores' files. */
export async function locations(host: Pick<Host, "read">): Promise<Locations> {
  const control = JSON.parse(await host.read(controlConfig) ?? "{}") as { harness?: { credentials?: string }; github?: { tokenFile?: string } };
  const probe = JSON.parse(await host.read(probeConfig) ?? "{}") as { node?: string; secretsFile?: string; backend?: { gitSsh?: { privateKeyFile?: string } } };
  return {
    harness: control.harness?.credentials ?? stores.harness.file,
    secrets: probe.secretsFile ?? stores.claude.file,
    gitKey: probe.backend?.gitSsh?.privateKeyFile ?? stores.gitKey.file,
    githubWatch: control.github?.tokenFile,
    node: probe.node,
  };
}

/**
 * What the installer does after: rewrite the configs for a new git key, or with github.tokenFile under the deployer's
 * lock, restart the probe, or install the control plane again.
 */
export type FollowUp = "config" | "watch" | "probe" | "control";

/** Fills `next` as it goes, so a run that fails partway still says what its writes need. */
export async function provision(role: "control" | "node", host: Host, answers: Answers, say: (line: string) => void, next = new Set<FollowUp>()): Promise<Set<FollowUp>> {
  const here = (store: Store) => store.machines === "every" || role === "control";
  const at = await locations(host);

  if (here(stores.harness)) {
    const file = at.harness;
    if (harnessSignedIn(await host.read(file) ?? "{}")) say(`Left the harness's login in ${file} alone.`);
    else {
      let how: string;
      for (;;) {
        how = await answers.choose({
          key: "NEXUS_HARNESS_LOGIN",
          say: "The harness runs every Nexus agent, and the control plane starts once it is signed in. How should it reach OpenAI?",
          choices: [{ id: "chatgpt", label: "Sign in with ChatGPT", terminal: true }, { id: "api-key", label: "An OpenAI API key" }, { id: "skip", label: "Skip for now" }],
          unattended: "api-key",
        });
        if (how !== "chatgpt") break;
        say("The browser's last step goes to port 1455 on this machine, so when that page fails to load, paste the address it ended on.");
        const [user] = stores.harness.owner.split(":");
        try {
          await host.run("runuser", ["-u", user!, "--", "env", "PATH=/usr/local/bin:/usr/bin", "node", login, controlConfig], { interactive: true });
          next.add("control");
          break;
        } catch (err) {
          say(`The ChatGPT login failed: ${(err as Error).message}.`);
        }
      }
      if (how === "api-key") {
        const key = await answers.secret({ key: "NEXUS_OPENAI_API_KEY", say: "Paste the OpenAI API key, or press Enter to skip:", check: token });
        if (key !== undefined) {
          const { deviceId } = JSON.parse(await host.read(file) ?? "{}") as { deviceId?: string };
          const credentials = { deviceId: deviceId ?? randomUUID(), credentials: { openai: { type: "api_key", key } } };
          await host.write(file, `${JSON.stringify(credentials, null, 2)}\n`, stores.harness);
          say(`Wrote the API key to ${file}. A harness on an API key hands pylons no ChatGPT login, so pi in a pylon needs its own.`);
          next.add("control");
        }
      }
    }
  }

  const addSecret = async (name: string, value: string) => {
    const file = at.secrets;
    const text = await host.read(file);
    if (text === undefined) await host.write(file, `${name}=${value}\n`, stores.claude);
    else await host.append(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${name}=${value}\n`);
    say(`Added ${name} to ${file}.`);
    next.add("probe");
  };

  const names = secretNames(await host.read(at.secrets) ?? "");
  const claudeName = claudeNames.find((name) => names.includes(name));
  if (claudeName !== undefined) say(`Left ${claudeName} in ${at.secrets} alone.`);
  else {
    const value = await answers.secret({
      key: "NEXUS_CLAUDE_TOKEN",
      say: "Claude workers and reviewers need a Claude token, which `claude setup-token` prints wherever Claude Code runs with a browser, or an Anthropic API key. Paste it, or press Enter to skip:",
      check: token,
    });
    if (value !== undefined) await addSecret(value.startsWith("sk-ant-api") ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN", value);
  }

  const existing = /^GH_TOKEN=(.*)$/m.exec(await host.read(at.secrets) ?? "")?.[1];
  let github = existing;
  if (existing !== undefined) say(`Left GH_TOKEN in ${at.secrets} alone.`);
  else {
    github = await answers.secret({
      key: "NEXUS_GH_TOKEN",
      say: "Pylons use a GitHub token for gh and git over HTTPS: a fine-grained token for all repositories with Administration and Contents read and write. Paste it, or press Enter to skip:",
      check: githubToken,
    });
    if (github !== undefined) await addSecret("GH_TOKEN", github);
  }

  if (here(stores.githubWatch)) {
    const { file } = stores.githubWatch;
    if (at.githubWatch !== undefined) say(`Left github.tokenFile ${at.githubWatch} in ${controlConfig} alone.`);
    else if (github !== undefined && githubToken(github) === undefined) {
      const kept = await host.exists(file);
      const watch = await answers.choose({
        key: "NEXUS_GITHUB_WATCH",
        say: kept
          ? `${file} exists, and ${controlConfig} names no github.tokenFile. Name it, for the pull request watch and the review loop?`
          : "Give the control plane the same GitHub token, for the pull request watch and the review loop? They also read pull requests, checks and commit statuses, and a landing merges, so the token needs those permissions too.",
        choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
        // Without a terminal, a run turns the watch on only for a token it was given, never on an install that had one.
        unattended: existing === undefined ? "yes" : "no",
      });
      if (watch === "yes") {
        if (kept) say(`Left ${file} alone.`);
        else await host.write(file, `${github}\n`, stores.githubWatch);
        say(`The installer names ${file} as github.tokenFile in ${controlConfig} next.`);
        next.add("watch");
        next.add("control");
      }
    }
  }

  const key = at.gitKey;
  if (await host.exists(key)) say(`Left the git SSH key ${key} alone.`);
  else if (await answers.choose({
    key: "NEXUS_GIT_KEY",
    say: "Pylons clone and push over SSH with a key that stays on this machine. Make one?",
    choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    unattended: "yes",
  }) === "yes") {
    let known: string | undefined;
    try {
      known = githubHostKeys(await host.run("ssh-keyscan", ["-t", "rsa,ecdsa,ed25519", "github.com"]));
    } catch (err) {
      say(`Made no git SSH key, because github.com's host keys could not be checked: ${(err as Error).message.trim()}. Rerun the installer to try again.`);
    }
    if (known !== undefined) {
      if (await host.exists(gitKnownHosts)) say(`Left ${gitKnownHosts} alone.`);
      else await host.write(gitKnownHosts, known, { mode: 0o644, owner: "root:root" });
      await host.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `nexus@${at.node ?? "node"}`, "-f", key]);
      await host.own(key, stores.gitKey);
      say(`Made the git SSH key ${key}. Add its public key to the GitHub account the pylons push as, at https://github.com/settings/ssh/new:`);
      say((await host.read(`${key}.pub`) ?? "").trim());
      next.add("config");
    }
  }
  return next;
}
