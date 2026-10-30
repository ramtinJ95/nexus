/** `nexus projects`, `project edit` and `project add`. */
import { defaultProjectResources, type Project } from "../../project.ts";
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

export const projectsCommands: Readonly<Record<string, Command>> = {
  projects: {
    args: [0, 0],
    async run(api) {
      const projects = await api("GET", "/v1/projects") as Project[];
      return { json: projects, text: projects.length === 0 ? "No projects." : table(projects.map((p) => [p.id, `node ${p.defaultNode}`, `branch ${p.defaultBranch}`, autoReviewText(p), pipelineText(p), p.repoUrl ?? "scratch"])) };
    },
  },
  "project edit": {
    args: [1, 1],
    options: {
      ...placementOptions,
      "allow-host": { type: "string", multiple: true }, login: { type: "string", multiple: true }, secret: { type: "string", multiple: true },
      "clear-hosts": { type: "boolean" }, "clear-logins": { type: "boolean" }, "clear-secrets": { type: "boolean" },
      "git-name": { type: "string" }, "git-email": { type: "string" }, "clear-git-identity": { type: "boolean" },
      "auto-review": { type: "string" }, pipeline: { type: "string" },
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
      const p = await api("PATCH", `/v1/projects/${encodeURIComponent(id!)}`, patch) as Project;
      return { json: p, text: `Updated project ${p.id}, ${autoReviewText(p)}, ${pipelineText(p)}. Existing threads keep their boot settings and grants; start a new thread to apply them.` };
    },
  },
  "project add": {
    args: [1, 2],
    options: {
      ...placementOptions,
      "allow-host": { type: "string", multiple: true }, login: { type: "string", multiple: true }, secret: { type: "string", multiple: true },
      scratch: { type: "boolean" },
    },
    async run(api, [id, url], v) {
      // A forgotten URL must not quietly make a scratch project.
      if ((url === undefined) === (v.scratch !== true)) throw new CliError("invalid", "project add takes a <repo-url> or --scratch, and not both");
      const repoUrl = url ?? null;
      const resources = { cpus: int(str(v, "cpus"), "--cpus", defaultProjectResources.cpus), memoryGiB: int(str(v, "memory"), "--memory", defaultProjectResources.memoryGiB), diskGiB: int(str(v, "disk"), "--disk", defaultProjectResources.diskGiB) };
      const secrets = strs(v, "secret").map(secretGrantOf);
      const p = await api("POST", "/v1/projects", {
        id, repoUrl, defaultBranch: str(v, "branch") ?? "main", defaultNode: str(v, "node") ?? "auto", resources,
        allowedHosts: strs(v, "allow-host"), secrets, logins: strs(v, "login"), preSetup: null,
      }) as Project;
      return { json: p, text: p.repoUrl === null ? `Added scratch project ${p.id} on ${p.defaultNode}` : `Added project ${p.id} (${p.repoUrl}) on ${p.defaultNode}` };
    },
  },
};
