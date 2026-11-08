/** `nexus projects`, `project show`, `project edit` and `project add`. */
import { readFileSync } from "node:fs";
import { secretHostPattern, secretNamePattern } from "../../protocol/secret-grants.ts";
import { CliError } from "../transport.ts";
import { type Command, str, strs, request, resourcesOf, resourceOptions, table } from "../kit.ts";
import { defaultSecondReview, projectRoutes, type LoginKind, type Project, type SecondReview } from "../../contract/projects.ts";

/**
 * `NAME:HOST[,HOST...]`, such as GH_TOKEN:api.github.com,github.com. A value pasted by mistake, as in NAME=value,
 * fails the name or host check, so it never reaches the API, and the error does not repeat it.
 */
function secretGrantOf(flag: string) {
  const colon = flag.indexOf(":");
  const name = flag.slice(0, colon);
  const hosts = flag.slice(colon + 1).split(",");
  if (colon === -1 || !secretNamePattern.test(name) || !hosts.every((host) => secretHostPattern.test(host))) {
    throw new CliError("invalid", "--secret takes NAME:HOST[,HOST...], an upper-case name and lower-case hostnames, such as GH_TOKEN:api.github.com,github.com. The value stays in each node's secret file");
  }
  return { name, hosts };
}

const autoReviews = { off: null, review: { mode: "review" }, land: { mode: "land" }, yolo: { mode: "yolo" } } as const;
/** `--auto-review`, as the API's edit takes it. */
function autoReviewOf(v: Parameters<typeof str>[0]) {
  const auto = str(v, "auto-review");
  if (auto === undefined) return undefined;
  if (!(auto in autoReviews)) throw new CliError("invalid", "--auto-review takes off, review, land or yolo");
  return autoReviews[auto as keyof typeof autoReviews];
}
const pipelines = { off: null, approve: { autoStart: false }, start: { autoStart: true } } as const;
const pipelineText = (p: Project) => p.pipeline == null ? "pipeline off" : p.pipeline.autoStart ? "pipeline starts items" : "pipeline waits for approval";
/** A control plane older than 0.67.0 sends `land` in place of the mode. */
const autoReviewText = (project: Project) => {
  const setting = project.autoReview as (NonNullable<Project["autoReview"]> & { land?: boolean }) | null | undefined;
  if (setting == null) return "auto review off";
  const mode = setting.mode ?? (setting.land === true ? "land" : "review");
  return mode === "yolo" ? `auto review and land, waiving holds, for ${setting.enabledBy}` : mode === "land" ? `auto review and land, for ${setting.enabledBy}` : `auto review, set by ${setting.enabledBy}`;
};

const secondReviewText = (p: Project) => {
  const rule = p.secondReview;
  if (rule == null) return "no second reviewer";
  if (rule.always) return "a second reviewer on another model for every pull request";
  return `a second reviewer on another model for a pull request with ${[...rule.reserved ? ["a reserved path hold"] : [], ...rule.lines === null ? [] : [`at least ${rule.lines} changed lines`]].join(" or ")}`;
};
/** `--second-reviewer`: off, on for the default rule, always, or a rule of `reserved` and `lines=N`, such as reserved,lines=150. */
function secondReviewOf(flag: string): SecondReview | null {
  if (flag === "off") return null;
  if (flag === "on") return defaultSecondReview;
  if (flag === "always") return { always: true };
  const parts = flag.split(",");
  const lines = parts.filter((part) => part.startsWith("lines=")).map((part) => /^lines=([1-9]\d{0,8})$/.exec(part)?.[1]);
  const valid = parts.every((part) => part === "reserved" || part.startsWith("lines=")) && lines.length <= 1 && lines.every((n) => n !== undefined) && new Set(parts).size === parts.length;
  if (!valid) throw new CliError("invalid", "--second-reviewer takes off, on, always, or reserved, lines=N or both, such as reserved,lines=150");
  return { always: false, lines: lines.length ? Number(lines[0]) : null, reserved: parts.includes("reserved") };
}

/** The text of `--rules-file`, read from stdin for `-`. The API trims it and refuses one that is empty or too long. */
function rulesFileOf(path: string): string {
  try {
    return readFileSync(path === "-" ? 0 : path, "utf8");
  } catch (err) {
    throw new CliError("invalid", `--rules-file could not read ${path === "-" ? "stdin" : path}: ${(err as Error).message}`);
  }
}

const listText = (values: readonly string[]) => values.length === 0 ? "none" : values.join(", ");
const rulesText = (p: Project) => p.standingRules?.text == null
  ? `No standing rules${p.standingRules == null ? "" : `, cleared at revision ${p.standingRules.revision}`}.`
  : `Standing rules, revision ${p.standingRules.revision}:\n\n${p.standingRules.text}`;
function projectText(p: Project): string {
  const { cpus, memoryGiB, diskGiB } = p.resources;
  return [
    `${p.id}: ${p.repoUrl ?? "scratch"}`,
    `node ${p.defaultNode}, branch ${p.defaultBranch}, ${cpus} CPUs, ${memoryGiB} GiB memory, ${diskGiB} GiB disk`,
    `hosts: ${listText(p.allowedHosts)}. logins: ${listText(p.logins)}. secrets: ${listText(p.secrets.map((grant) => grant.name))}`,
    ...p.gitIdentity == null ? [] : [`git identity: ${p.gitIdentity.name} <${p.gitIdentity.email}>`],
    `${autoReviewText(p)}, ${pipelineText(p)}`,
    ...p.secondReview == null ? [] : [secondReviewText(p)],
    "",
    rulesText(p),
  ].join("\n");
}

export const projectsCommands: Readonly<Record<string, Command>> = {
  projects: {
    help: ["  nexus projects"],
    args: [0, 0],
    async run(api) {
      const projects = await request(api, projectRoutes.list, {});
      return { json: projects, text: projects.length === 0 ? "No projects." : table(projects.map((p) => [p.id, `node ${p.defaultNode}`, `branch ${p.defaultBranch}`, autoReviewText(p), pipelineText(p), p.repoUrl ?? "scratch"])) };
    },
  },
  "project show": {
    help: [
      "  nexus project show <id>                      a project's settings, and the standing rules each builder thread gets with its first message",
      "    project add and project edit set the rules with --rules-file PATH, or - for stdin, and project edit --clear-rules clears them",
    ],
    args: [1, 1],
    async run(api, [id]) {
      // From the list, so the command needs no route newer than `projects`.
      const p = (await request(api, projectRoutes.list, {})).find((project) => project.id === id);
      if (p === undefined) throw new CliError("not-found", `no project ${id}`);
      return { json: p, text: projectText(p) };
    },
  },
  "project edit": {
    help: [
      "  nexus project edit <id> [--node N|auto] [--branch B] [--cpus n] [--memory GiB] [--disk GiB]",
      "    [--allow-host HOST]... [--login claude|chatgpt]... [--secret NAME:HOST[,HOST]...]...",
      "    [--clear-hosts] [--clear-logins] [--clear-secrets] [--git-name NAME --git-email EMAIL | --clear-git-identity]",
      "    [--auto-review off|review|land|yolo]   review each builder's PR on its own, land it too, and with yolo waive the holds you may; land and yolo need a deployer",
      "    [--pipeline off|approve|start]    turn pipeline items into threads, once the person approves each or on their own",
      "    [--second-reviewer off|on|always|reserved,lines=N]   a second reviewer on another model for the PRs the rule names",
    ],
    args: [1, 1],
    options: {
      node: { type: "string" }, branch: { type: "string" }, ...resourceOptions,
      "allow-host": { type: "string", multiple: true }, login: { type: "string", multiple: true }, secret: { type: "string", multiple: true },
      "clear-hosts": { type: "boolean" }, "clear-logins": { type: "boolean" }, "clear-secrets": { type: "boolean" },
      "git-name": { type: "string" }, "git-email": { type: "string" }, "clear-git-identity": { type: "boolean" },
      "auto-review": { type: "string" }, pipeline: { type: "string" }, "rules-file": { type: "string" }, "clear-rules": { type: "boolean" },
      "second-reviewer": { type: "string" },
    },
    async run(api, [id], v) {
      const patch: Record<string, unknown> = {};
      for (const [flag, field] of [["node", "defaultNode"], ["branch", "defaultBranch"]] as const) {
        if (v[flag] !== undefined) patch[field] = str(v, flag);
      }
      const resources = resourcesOf(v);
      if (resources !== undefined) patch.resources = resources;
      for (const [flag, clear, field] of [["allow-host", "clear-hosts", "allowedHosts"], ["login", "clear-logins", "logins"], ["secret", "clear-secrets", "secrets"]] as const) {
        if (v[clear] && v[flag] !== undefined) throw new CliError("invalid", `--${clear} conflicts with --${flag}`);
        if (v[clear] || v[flag] !== undefined) patch[field] = flag === "secret" ? strs(v, flag).map(secretGrantOf) : strs(v, flag);
      }
      const name = str(v, "git-name"), email = str(v, "git-email");
      if ((name === undefined) !== (email === undefined) || (v["clear-git-identity"] && name !== undefined)) throw new CliError("invalid", "use --git-name with --git-email, or --clear-git-identity");
      if (v["clear-git-identity"]) patch.gitIdentity = null;
      else if (name !== undefined) patch.gitIdentity = { name, email };
      const auto = autoReviewOf(v);
      if (auto !== undefined) patch.autoReview = auto;
      const items = str(v, "pipeline");
      if (items !== undefined) {
        if (!(items in pipelines)) throw new CliError("invalid", "--pipeline takes off, approve or start");
        patch.pipeline = pipelines[items as keyof typeof pipelines];
      }
      const second = str(v, "second-reviewer");
      if (second !== undefined) patch.secondReview = secondReviewOf(second);
      const rulesFile = str(v, "rules-file");
      if (v["clear-rules"] && rulesFile !== undefined) throw new CliError("invalid", "--clear-rules conflicts with --rules-file");
      if (v["clear-rules"]) patch.standingRules = null;
      else if (rulesFile !== undefined) patch.standingRules = rulesFileOf(rulesFile);
      const p = await request(api, projectRoutes.edit, { project: id!, body: patch });
      const rules = patch.standingRules === undefined ? "" : p.standingRules?.text == null ? " It has no standing rules." : ` Builder threads started from now get its standing rules, revision ${p.standingRules.revision}.`;
      return { json: p, text: `Updated project ${p.id}, ${autoReviewText(p)}, ${pipelineText(p)}${second === undefined ? "" : `, ${secondReviewText(p)}`}. Existing threads keep their boot settings and grants; start a new thread to apply them.${rules}` };
    },
  },
  "project add": {
    help: [
      "  nexus project add <id> (<repo-url> | --scratch) [--node N|auto] [--branch B] [--cpus n] [--memory GiB] [--disk GiB]",
      "                    [--allow-host HOST]... [--login claude|chatgpt]... [--secret NAME:HOST[,HOST]...]... [--rules-file PATH|-]",
      "                    [--auto-review off|review|land|yolo]",
    ],
    args: [1, 2],
    options: {
      node: { type: "string" }, branch: { type: "string" }, ...resourceOptions,
      "allow-host": { type: "string", multiple: true }, login: { type: "string", multiple: true }, secret: { type: "string", multiple: true },
      scratch: { type: "boolean" }, "rules-file": { type: "string" }, "auto-review": { type: "string" },
    },
    async run(api, [id, url], v) {
      // A forgotten URL must not quietly make a scratch project.
      if ((url === undefined) === (v.scratch !== true)) throw new CliError("invalid", "project add takes a <repo-url> or --scratch, and not both");
      const repoUrl = url ?? null;
      const resources = resourcesOf(v);
      const secrets = strs(v, "secret").map(secretGrantOf);
      const rulesFile = str(v, "rules-file");
      const auto = autoReviewOf(v);
      const [branch, node] = [str(v, "branch"), str(v, "node")];
      const added = await request(api, projectRoutes.add, { body: {
        id: id!, repoUrl, ...branch === undefined ? {} : { defaultBranch: branch }, ...node === undefined ? {} : { defaultNode: node }, ...resources === undefined ? {} : { resources },
        // The API refuses a login it does not know.
        allowedHosts: strs(v, "allow-host"), secrets, logins: strs(v, "login") as LoginKind[],
        ...rulesFile === undefined ? {} : { standingRules: rulesFileOf(rulesFile) },
      } });
      // Only an edit records who turned auto review on, so a new project's add cannot name someone else.
      let p = added;
      if (auto != null) {
        try {
          p = await request(api, projectRoutes.edit, { project: added.id, body: { autoReview: auto } });
        } catch (err) {
          if (!(err instanceof CliError)) throw err;
          throw new CliError(err.kind, `Added project ${added.id}, but its auto review was not set: ${err.message}. Set it with nexus project edit ${added.id} --auto-review`, err.status, err.code, err.retryable);
        }
      }
      const rules = p.standingRules == null ? "" : ", with standing rules";
      const review = auto == null ? "" : `, ${autoReviewText(p)}`;
      return { json: p, text: p.repoUrl === null ? `Added scratch project ${p.id} on ${p.defaultNode}${rules}${review}` : `Added project ${p.id} (${p.repoUrl}) on ${p.defaultNode}${rules}${review}` };
    },
  },
};
