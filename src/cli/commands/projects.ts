/** `nexus projects`, `project show`, `project edit` and `project add`. */
import { readFileSync } from "node:fs";
import { defaultProjectResources, defaultSecondReview, type Project, type SecondReview } from "../../control/project.ts";
import { secretHostPattern, secretNamePattern, type SecretGrant } from "../../secret-grants.ts";
import { CliError } from "../transport.ts";
import { type Command, str, strs, int, resourcesOf, placementOptions, table } from "../kit.ts";

/**
 * `NAME:HOST[,HOST...]`, such as GH_TOKEN:api.github.com,github.com. A value pasted by mistake, as in NAME=value,
 * fails the name or host check, so it never reaches the API, and the error does not repeat it.
 */
function secretGrantOf(flag: string): SecretGrant {
  const colon = flag.indexOf(":");
  const name = flag.slice(0, colon);
  const hosts = flag.slice(colon + 1).split(",");
  if (colon === -1 || !secretNamePattern.test(name) || !hosts.every((host) => secretHostPattern.test(host))) {
    throw new CliError("invalid", "--secret takes NAME:HOST[,HOST...], an upper-case name and lower-case hostnames, such as GH_TOKEN:api.github.com,github.com. The value stays in each node's secret file");
  }
  return { name, hosts };
}

const autoReviews = { off: null, review: { land: false }, land: { land: true } } as const;
const pipelines = { off: null, approve: { autoStart: false }, start: { autoStart: true } } as const;
const pipelineText = (p: Project) => p.pipeline == null ? "pipeline off" : p.pipeline.autoStart ? "pipeline starts items" : "pipeline waits for approval";
const autoReviewText = (p: Project) => p.autoReview == null ? "auto review off" : p.autoReview.land ? `auto review and land, for ${p.autoReview.enabledBy}` : `auto review, set by ${p.autoReview.enabledBy}`;

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
    args: [0, 0],
    async run(api) {
      const projects = await api("GET", "/v1/projects") as Project[];
      return { json: projects, text: projects.length === 0 ? "No projects." : table(projects.map((p) => [p.id, `node ${p.defaultNode}`, `branch ${p.defaultBranch}`, autoReviewText(p), pipelineText(p), p.repoUrl ?? "scratch"])) };
    },
  },
  "project show": {
    args: [1, 1],
    async run(api, [id]) {
      // From the list, so the command needs no route newer than `projects`.
      const p = (await api("GET", "/v1/projects") as Project[]).find((project) => project.id === id);
      if (p === undefined) throw new CliError("not-found", `no project ${id}`);
      return { json: p, text: projectText(p) };
    },
  },
  "project edit": {
    args: [1, 1],
    options: {
      ...placementOptions,
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
      const auto = str(v, "auto-review");
      if (auto !== undefined) {
        if (!(auto in autoReviews)) throw new CliError("invalid", "--auto-review takes off, review or land");
        patch.autoReview = autoReviews[auto as keyof typeof autoReviews];
      }
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
      const p = await api("PATCH", `/v1/projects/${encodeURIComponent(id!)}`, patch) as Project;
      const rules = patch.standingRules === undefined ? "" : p.standingRules?.text == null ? " It has no standing rules." : ` Builder threads started from now get its standing rules, revision ${p.standingRules.revision}.`;
      return { json: p, text: `Updated project ${p.id}, ${autoReviewText(p)}, ${pipelineText(p)}${second === undefined ? "" : `, ${secondReviewText(p)}`}. Existing threads keep their boot settings and grants; start a new thread to apply them.${rules}` };
    },
  },
  "project add": {
    args: [1, 2],
    options: {
      ...placementOptions,
      "allow-host": { type: "string", multiple: true }, login: { type: "string", multiple: true }, secret: { type: "string", multiple: true },
      scratch: { type: "boolean" }, "rules-file": { type: "string" },
    },
    async run(api, [id, url], v) {
      // A forgotten URL must not quietly make a scratch project.
      if ((url === undefined) === (v.scratch !== true)) throw new CliError("invalid", "project add takes a <repo-url> or --scratch, and not both");
      const repoUrl = url ?? null;
      const resources = { cpus: int(str(v, "cpus"), "--cpus", defaultProjectResources.cpus), memoryGiB: int(str(v, "memory"), "--memory", defaultProjectResources.memoryGiB), diskGiB: int(str(v, "disk"), "--disk", defaultProjectResources.diskGiB) };
      const secrets = strs(v, "secret").map(secretGrantOf);
      const rulesFile = str(v, "rules-file");
      const p = await api("POST", "/v1/projects", {
        id, repoUrl, defaultBranch: str(v, "branch") ?? "main", defaultNode: str(v, "node") ?? "auto", resources,
        allowedHosts: strs(v, "allow-host"), secrets, logins: strs(v, "login"), preSetup: null,
        ...rulesFile === undefined ? {} : { standingRules: rulesFileOf(rulesFile) },
      }) as Project;
      const rules = p.standingRules == null ? "" : ", with standing rules";
      return { json: p, text: p.repoUrl === null ? `Added scratch project ${p.id} on ${p.defaultNode}${rules}` : `Added project ${p.id} (${p.repoUrl}) on ${p.defaultNode}${rules}` };
    },
  },
};
