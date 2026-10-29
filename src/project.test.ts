import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { VM } from "@earendil-works/gondolin";
import { actionSchema } from "./pylon-vm/contracts.ts";
import { GuestServices } from "./pylon-vm/services.ts";
import { bootSecrets, chatgptTokenGrant, effectiveAllowedHosts, githubTokenGrant, parseServicesFile, renderOverlay, secretHostPattern, secretNamePattern, serviceDecl, type Project, type ProjectId, type PylonOverlay } from "./project.ts";
import type { NodeName, PylonId } from "./protocol.ts";

const usageExample = `
services:
  api:
    command: pnpm --filter api dev --port $PORT
    cwd: apps/api
    health: /healthz
    preview: { title: API }
  web:
    command: pnpm --filter web dev --port $PORT --host 127.0.0.1
    cwd: apps/web
    health: /
    preview: true
    env:
      API_URL: \${services.api.publicURL}
`;

test("parseServicesFile accepts the usage example as written, adding no defaults", () => {
  assert.deepEqual(parseServicesFile(usageExample), {
    services: {
      api: { command: "pnpm --filter api dev --port $PORT", cwd: "apps/api", health: "/healthz", preview: { title: "API" } },
      web: { command: "pnpm --filter web dev --port $PORT --host 127.0.0.1", cwd: "apps/web", health: "/", preview: true, env: { API_URL: "${services.api.publicURL}" } },
    },
  });
});

test("parseServicesFile accepts preview links, a fixed port and the remaining fields", () => {
  const file = parseServicesFile(`
services:
  docs:
    command: mkdocs serve
    port: 8000
    health: process
    platforms: [linux]
    timeoutMs: 60000
    previews:
      - { url: /, title: Home }
      - folder: Guides
        links: [{ url: "https://example.com/a", title: A, description: first }]
  worker:
    command: node worker.js
    env: { DOCS: "see \${services.docs.publicURL}/guides" }
`);
  assert.equal(file.services.docs!.port, 8000);
  assert.equal(file.services.worker!.env!.DOCS, "see ${services.docs.publicURL}/guides");
});

const rejects: Record<string, [yaml: string, message: RegExp]> = {
  "duplicate keys": ["services:\n  a: { command: x }\n  a: { command: y }\n", /unique/i],
  "an alias bomb": [
    "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nservices: {}\n",
    /alias/i,
  ],
  "an unknown top-level key": ["version: 1\nservices: {}\n", /version/],
  "an unknown service field": ["services:\n  a: { command: x, review: false }\n", /review/],
  "a missing command": ["services:\n  a: { cwd: . }\n", /command/],
  "a bad service name": ["services:\n  Web: { command: x }\n", /Web/],
  "an absolute cwd": ["services:\n  a: { command: x, cwd: /etc }\n", /inside the repo/],
  "a cwd that leaves the repo": ["services:\n  a: { command: x, cwd: apps/../../x }\n", /inside the repo/],
  "a health path without a slash": ["services:\n  a: { command: x, health: healthz }\n", /health/],
  "a preview URL that is neither a path nor http(s)": ["services:\n  a: { command: x, preview: { url: 'ftp://h/' } }\n", /http/],
  "duplicate preview folders": ["services:\n  a:\n    command: x\n    previews: [{ folder: F, links: [{ url: /, title: t }] }, { folder: F, links: [{ url: /, title: t }] }]\n", /unique/],
  "PORT in env": ["services:\n  a: { command: x, env: { PORT: '1' } }\n", /PORT is managed/],
  "PUBLIC_URL in env": ["services:\n  a: { command: x, env: { PUBLIC_URL: u } }\n", /PUBLIC_URL is managed/],
  "a NEXUS_ name in env": ["services:\n  a: { command: x, env: { NEXUS_THREAD_ID: t } }\n", /NEXUS_THREAD_ID is managed/],
  "a fixed port that is Nexus's own": ["services:\n  a: { command: x, port: 750 }\n", /is Nexus's own: sshd's 22, or the preview relay's 700 to 799/],
  "duplicate fixed ports": ["services:\n  a: { command: x, port: 3000 }\n  b: { command: y, port: 3000 }\n", /port 3000 is also fixed by a/],
  "a reference to an unknown service": ["services:\n  a: { command: x, env: { U: '${services.b.publicURL}' } }\n", /names b, which is not a declared service with a preview/],
  "a reference to a service without a preview": ["services:\n  a: { command: x, env: { U: '${services.b.publicURL}' } }\n  b: { command: y }\n", /names b/],
  "a misspelled reference": ["services:\n  a: { command: x, env: { U: '${services.b.publicUrl}' } }\n  b: { command: y, preview: true }\n", /is not a whole \$\{services.<name>.publicURL\} reference/],
  "a reference cycle": [
    "services:\n  a: { command: x, preview: true, env: { U: '${services.b.publicURL}' } }\n  b: { command: y, preview: true, env: { U: '${services.a.publicURL}' } }\n",
    /cycle: a -> b -> a/,
  ],
  "an unterminated reference": ["services:\n  a: { command: x, preview: true }\n  b: { command: y, env: { U: '${services.a.publicURL' } }\n", /is not a whole/],
  "service keys that collapse to one string": ["services:\n  1: { command: a }\n  '1': { command: b }\n", /key 1 is not a string/],
  "an env key that is not a string": ["services:\n  a: { command: x, env: { true: y } }\n", /key true is not a string/],
  "a file over 1 MiB": [`services: {}\n#${"x".repeat(1_048_576)}\n`, /larger than 1048576 bytes/],
  "a self reference": ["services:\n  a: { command: x, preview: true, env: { U: '${services.a.publicURL}' } }\n", /cycle: a -> a/],
  "an empty file": ["", /services/],
};

for (const [name, [yaml, message]] of Object.entries(rejects)) {
  test(`parseServicesFile rejects ${name}`, () => {
    assert.throws(() => parseServicesFile(yaml), message);
  });
}

test("parseServicesFile accepts a reference chain that is not a cycle", () => {
  const file = parseServicesFile(
    "services:\n  a: { command: x, preview: true }\n  b: { command: y, preview: true, env: { A: '${services.a.publicURL}' } }\n  c: { command: z, env: { A: '${services.a.publicURL}', B: '${services.b.publicURL}' } }\n",
  );
  assert.deepEqual(Object.keys(file.services), ["a", "b", "c"]);
});

/**
 * A guest whose only file is `yaml`. Every command it is asked to run succeeds, every port answers, each free port
 * asked for is the next from 41000, and its preview relay applies each map as it is written.
 */
function guestWith(yaml: string): VM {
  let nextPort = 41000;
  let relayStatus = "";
  return {
    async enableIngress() {
      return { url: "http://127.0.0.1:9/" };
    },
    setIngressRoutes() {},
    async exec(argv: string[], options: { stdout: Writable }) {
      const command = argv[3]!;
      const map = /relays\.json\.new' && mv /.test(command) ? /printf '%s' '([^']*)'/.exec(command) : null;
      if (map) {
        const { generation, relays } = JSON.parse(map[1]!);
        relayStatus = JSON.stringify({ generation, bound: relays, failed: {} });
      }
      if (command.startsWith("cat ") && command.includes("relay-status.json")) options.stdout.write(relayStatus);
      else if (command.includes("connect_ex")) options.stdout.write("True\n");
      else if (command.includes("getsockname")) options.stdout.write(`${nextPort++}\n`);
      return { exitCode: 0, stderr: JSON.stringify({ state: "exited", exitCode: 0 }) };
    },
    fs: {
      async stat() {
        return { size: Buffer.byteLength(yaml) };
      },
      async readFile() {
        return yaml;
      },
      async writeFile() {},
    },
  } as unknown as VM;
}
/** The pylon's own path for the file: the `ensure` its supervisor runs on every boot. */
async function backendAccepts(yaml: string): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "nexus-services-"));
  const services = new GuestServices(guestWith(yaml), dir, "/workspace/repo/.nexus/services.yaml", "/workspace/repo", "user", { a: "https://a.example/" });
  try {
    await services.operate("ensure");
    return true;
  } catch {
    return false;
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const nexusAccepts = (yaml: string): boolean => {
  try {
    parseServicesFile(yaml);
    return true;
  } catch {
    return false;
  }
};

const svc = (fields: string): string => `services:\n  a: { command: x, ${fields} }\n`;
const agreement: [name: string, yaml: string][] = [
  ["the usage example", usageExample],
  ["preview links and every optional field", "services:\n  a:\n    command: x\n    cwd: apps/a\n    port: 3000\n    health: process\n    platforms: [linux, darwin]\n    timeoutMs: 100\n    preview: { url: 'https://example.com/', title: A, description: d }\n    previews: [{ url: /, title: Home }, { folder: F, links: [{ url: /x, title: X }] }]\n"],
  ["AMP_THREAD_ID in env", svc("env: { AMP_THREAD_ID: t }")],
  ["$AMP_USER_EMAIL in a preview url", svc("preview: { url: '/u/$AMP_USER_EMAIL' }")],
  ["$AMP_USER_EMAIL in a preview title", svc("preview: { title: '$AMP_USER_EMAIL' }")],
  ["$AMP_USER_EMAIL in a preview description", svc("preview: { description: 'for $AMP_USER_EMAIL' }")],
  ["$AMP_USER_EMAIL in a link url", svc("previews: [{ url: '/$AMP_USER_EMAIL', title: t }]")],
  ["$AMP_USER_EMAIL in a link title", svc("previews: [{ url: /, title: '$AMP_USER_EMAIL' }]")],
  ["$AMP_USER_EMAIL in a link description", svc("previews: [{ url: /, title: t, description: '$AMP_USER_EMAIL' }]")],
  ["PORT in env", svc("env: { PORT: '1' }")],
  ["PUBLIC_URL in env", svc("env: { PUBLIC_URL: u }")],
  ["a bad env name", svc("env: { 1A: u }")],
  ["duplicate fixed ports", "services:\n  a: { command: x, port: 3000 }\n  b: { command: y, port: 3000 }\n"],
  ["duplicate keys", "services:\n  a: { command: x }\n  a: { command: y }\n"],
  ["an alias bomb", "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nservices: {}\n"],
  ["a file over 1 MiB", `services: {}\n#${"x".repeat(1_048_576)}\n`],
  ["an empty file", ""],
  ["an unknown service field", svc("restart: always")],
  ["a bad service name", "services:\n  Web: { command: x }\n"],
  ["an empty command", svc("cwd: .").replace("command: x", "command: ''")],
  ["port 0", svc("port: 0")],
  ["a fractional port", svc("port: 80.5")],
  ["a health path without a slash", svc("health: healthz")],
  ["an ftp preview url", svc("preview: { url: 'ftp://h/' }")],
  ["a protocol-relative preview url", svc("preview: { url: '//h/' }")],
  ["an empty link title", svc("previews: [{ url: /, title: '' }]")],
  ["a folder without links", svc("previews: [{ folder: F, links: [] }]")],
  ["duplicate folders", svc("previews: [{ folder: F, links: [{ url: /, title: t }] }, { folder: F, links: [{ url: /, title: t }] }]")],
  ["no platforms", svc("platforms: []")],
  ["an unknown platform", svc("platforms: [windows]")],
  ["a timeout under 100 ms", svc("timeoutMs: 50")],
  ["a timeout over 2 minutes", svc("timeoutMs: 120001")],
  ["a NEXUS_ name in env", svc("env: { NEXUS_NODE: n }")],
  ["a NEXUS_ name Nexus does not set in env", svc("env: { NEXUS_FOO: n }")],
  ["an absolute cwd", svc("cwd: /etc")],
  ["a cwd that leaves the repo", svc("cwd: ../x")],
  ["an empty preview title", svc("preview: { title: '' }")],
  ["review: false", svc("review: false")],
  ["a top-level version", "version: 1\nservices: {}\n"],
  ["a top-level setup", "setup: [make]\nservices: {}\n"],
  ["a reference to a service without a preview", "services:\n  a: { command: x }\n  b: { command: y, env: { U: '${services.a.publicURL}' } }\n"],
  ["an unterminated reference", "services:\n  a: { command: x, preview: true }\n  b: { command: y, env: { U: '${services.a.publicURL' } }\n"],
  ["a reference cycle", "services:\n  a: { command: x, preview: true, env: { U: '${services.a.publicURL}' } }\n"],
  ["service keys that collapse to one string", "services:\n  1: { command: a }\n  '1': { command: b }\n"],
];

test("parseServicesFile and the pylon's supervisor accept exactly the same files", async () => {
  const disagreements: string[] = [];
  for (const [name, yaml] of agreement) if (nexusAccepts(yaml) !== await backendAccepts(yaml)) disagreements.push(name);
  assert.deepEqual(disagreements, []);
});

test("the in-pylon API's serviceDecl and the controller's service-start accept exactly the same services", () => {
  const decls: [name: string, decl: Record<string, unknown>][] = [
    ["a plain service", { command: "x", cwd: "apps/a", preview: { title: "A" } }],
    ["PORT in env", { command: "x", env: { PORT: "1" } }],
    ["a NEXUS_ name in env", { command: "x", env: { NEXUS_NODE: "n" } }],
    ["an absolute cwd", { command: "x", cwd: "/etc" }],
    ["a cwd that leaves the repo", { command: "x", cwd: "../x" }],
    ["an empty preview title", { command: "x", preview: { title: "" } }],
    ["review: false", { command: "x", review: false }],
  ];
  const disagreements = decls.flatMap(([name, decl]) =>
    serviceDecl.safeParse(decl).success === actionSchema.safeParse({ action: "service-start", name: "pylon-1", service: "a", ...decl }).success ? [] : [name]);
  assert.deepEqual(disagreements, []);
});

const project: Project = {
  id: "acme-web" as ProjectId,
  repoUrl: "git@github.com:ramtin/acme-web.git",
  defaultBranch: "main",
  defaultNode: "rj-firebat" as NodeName,
  resources: { cpus: 4, memoryGiB: 8, diskGiB: 20 },
  allowedHosts: ["registry.npmjs.org", "api.stripe.com"],
  secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com", "files.stripe.com"] }],
  logins: ["chatgpt"],
  preSetup: null,
};

test("effectiveAllowedHosts joins project hosts, login hosts and secret hosts, sorted and deduped", () => {
  assert.deepEqual(effectiveAllowedHosts(project), [
    "api.openai.com", "api.stripe.com", "auth.openai.com", "chatgpt.com", "files.stripe.com", "registry.npmjs.org",
  ]);
  assert.deepEqual(effectiveAllowedHosts({ ...project, allowedHosts: [], secrets: [], logins: [] }), []);
});

test("effectiveAllowedHosts lets a project reach its own HTTPS repo host, and adds nothing for an SSH one", () => {
  const bare = { ...project, allowedHosts: [], secrets: [], logins: [] };
  assert.deepEqual(effectiveAllowedHosts({ ...bare, repoUrl: "https://github.com/octocat/Spoon-Knife.git" }), ["github.com"]);
  assert.deepEqual(effectiveAllowedHosts({ ...bare, repoUrl: "https://Git.Example.com:8443/acme/web.git", allowedHosts: ["git.example.com"] }), ["git.example.com"]);
  assert.deepEqual(effectiveAllowedHosts({ ...bare, repoUrl: "ssh://git@github.com/acme/web.git" }), []);
});

test("effectiveAllowedHosts of a scratch project adds no repo host and keeps its grants' hosts", () => {
  const scratch = { ...project, repoUrl: null, allowedHosts: [], logins: [] };
  assert.deepEqual(effectiveAllowedHosts({ ...scratch, secrets: [] }), []);
  assert.deepEqual(effectiveAllowedHosts({ ...scratch, secrets: [githubTokenGrant] }), ["api.github.com", "github.com"]);
});

test("a pylon is granted the ChatGPT token exactly when its project has the chatgpt login", () => {
  assert.deepEqual(bootSecrets(project), [...project.secrets, { name: "NEXUS_CHATGPT_TOKEN", hosts: ["api.openai.com"] }]);
  assert.deepEqual(bootSecrets({ ...project, logins: ["claude"] }), project.secrets);
  assert.deepEqual(bootSecrets({ ...project, logins: [] }), project.secrets);
});

const overlay: PylonOverlay = {
  pylonId: "pylon-t1" as PylonId,
  threadId: "t1",
  project: "acme-web" as ProjectId,
  node: "rj-firebat" as NodeName,
  allowedHosts: ["api.openai.com", "registry.npmjs.org"],
  previews: [{ service: "web", url: "https://rj-firebat.example.ts.net:8443/" }],
  logins: ["chatgpt"],
  dotfiles: { repo: "git@github.com:ramtin/dotfiles.git", ref: "abc123" },
  repo: { kind: "clone", url: "git@github.com:ramtin/acme-web.git", checkout: { branch: "main", commit: "origin/main" } },
  secrets: [],
};

test("renderOverlay renders the profile script, pylon.json and PYLON.md", () => {
  const files = renderOverlay(overlay);
  assert.deepEqual(files.map(({ path, mode, owner }) => [path, mode, owner]), [
    ["/etc/profile.d/nexus.sh", 0o644, "root"],
    ["/home/user/.nexus/pylon.json", 0o644, "user"],
    ["/home/user/.nexus/PYLON.md", 0o644, "user"],
  ]);
  assert.deepEqual(renderOverlay(overlay), files, "the same overlay renders the same bytes, so LiveHash is stable");
});

test("the profile script exports the NEXUS_ facts to a login shell, quoting every value", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-overlay-"));
  const script = join(dir, "nexus.sh");
  writeFileSync(script, renderOverlay({ ...overlay, threadId: "it's $HOME `id`" })[0]!.content);
  const env = execFileSync("sh", ["-c", `. "$1" && env`, "sh", script], { encoding: "utf8", env: {} });
  const nexus = Object.fromEntries(env.split("\n").filter((l) => l.startsWith("NEXUS_")).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.deepEqual(nexus, {
    NEXUS_PYLON: "1",
    NEXUS_PYLON_ID: "pylon-t1",
    NEXUS_THREAD_ID: "it's $HOME `id`",
    NEXUS_PROJECT: "acme-web",
    NEXUS_NODE: "rj-firebat",
    NEXUS_API: "http://nexus.pylon",
  });
});

test("pylon.json carries the overlay facts for nexus info --json", () => {
  assert.deepEqual(JSON.parse(renderOverlay(overlay)[1]!.content), {
    pylonId: "pylon-t1",
    threadId: "t1",
    project: "acme-web",
    node: "rj-firebat",
    api: "http://nexus.pylon",
    allowedHosts: ["api.openai.com", "registry.npmjs.org"],
    previews: [{ service: "web", url: "https://rj-firebat.example.ts.net:8443/" }],
    logins: ["chatgpt"],
    dotfiles: { repo: "git@github.com:ramtin/dotfiles.git", ref: "abc123" },
  });
});

test("PYLON.md tells the agent its hosts, previews, logins and how to declare outputs", () => {
  const md = renderOverlay(overlay)[2]!.content;
  for (const fact of ["Thread: t1", "- api.openai.com\n", "- registry.npmjs.org\n", "Every other host is blocked", "web: https://rj-firebat.example.ts.net:8443/", "chatgpt", "device-code", "nexus output add file", "only files on disk survive", "X-Forwarded-Proto: https", "server.allowedHosts"]) {
    assert.ok(md.includes(fact), `PYLON.md mentions ${JSON.stringify(fact)}`);
  }
  const bare = renderOverlay({ ...overlay, previews: [], logins: [] })[2]!.content;
  assert.match(bare, /No previews are published yet/);
  assert.match(bare, /no interactive logins/);
  assert.doesNotMatch(bare, /device-code/);
});

test("PYLON.md of a pylon granted the ChatGPT token says pi is signed in to it, and device-code only for the other logins", () => {
  const md = renderOverlay({ ...overlay, secrets: [chatgptTokenGrant] })[2]!.content;
  for (const fact of [
    "pi is already signed in to ChatGPT as its `openai` provider", "`openai/gpt-6-astra`", "Nexus rewrites that entry of ~/.pi/agent/auth.json on every boot",
    "`openai-codex` provider is not signed in, and needs no `/login`", "## Secrets", "- NEXUS_CHATGPT_TOKEN: api.openai.com\n",
  ]) assert.ok(md.includes(fact), `PYLON.md mentions ${JSON.stringify(fact)}`);
  assert.doesNotMatch(md, /device-code|no interactive logins/);

  const withClaude = renderOverlay({ ...overlay, logins: ["claude", "chatgpt"], secrets: [chatgptTokenGrant] })[2]!.content;
  assert.ok(withClaude.includes("This project also allows these logins: claude. Sign in with the device-code flow"));

  const bootedBefore = renderOverlay({ ...overlay, secrets: [] })[2]!.content;
  assert.ok(bootedBefore.includes("This project allows these logins: chatgpt. Sign in with the device-code flow"), "a pylon booted without the grant was not signed in");
  assert.doesNotMatch(bootedBefore, /signed in to ChatGPT/);
});

test("PYLON.md tells Claude Code to have a shepherdr reviewer check its diff before a pull request, and whether pi is signed in for it", () => {
  const md = renderOverlay({ ...overlay, secrets: [chatgptTokenGrant] })[2]!.content;
  for (const fact of [
    "## Review before a pull request", "`mcp__shepherdr__agents`", "Before you open a pull request or push to one", "`agent_type: \"reviewer\"`",
    "which findings you accepted and which you rejected, and why", "Without the tool, say the review was skipped",
    "The reviewer runs on pi's `openai` provider, which is signed in here",
  ]) assert.ok(md.includes(fact), `PYLON.md mentions ${JSON.stringify(fact)}`);
  const notGranted = renderOverlay({ ...overlay, secrets: [] })[2]!.content;
  assert.ok(notGranted.includes("This pylon was not granted the ChatGPT token"), "says why the reviewer cannot run");
  assert.ok(notGranted.includes("the review was skipped and why"));
  assert.doesNotMatch(notGranted, /which is signed in here/);
});

test("PYLON.md of a scratch project with GitHub access says nothing is kept and how to publish without inventing an author", () => {
  const md = renderOverlay({ ...overlay, repo: { kind: "empty", branch: "trunk" }, secrets: [githubTokenGrant] })[2]!.content;
  for (const fact of [
    "new repository on branch trunk with no commits and no remote", "Nothing in this pylon is kept when the thread is deleted",
    "Nexus has no git identity configured", "do not invent an identity",
    "gh repo create <owner>/<name> --private --source . --remote origin --push", "Use HTTPS remotes",
    "## Secrets", "- GH_TOKEN: api.github.com, github.com\n", "changes on every boot",
  ]) assert.ok(md.includes(fact), `PYLON.md mentions ${JSON.stringify(fact)}`);
  assert.doesNotMatch(md, /ask the human which name/);
});

test("PYLON.md of a scratch project without GitHub access says how to get it and to ask for a git author", () => {
  const md = renderOverlay({ ...overlay, repo: { kind: "empty", branch: "main" } })[2]!.content;
  assert.ok(md.includes("new repository on branch main with no commits and no remote"));
  assert.ok(md.includes("--scratch --secret GH_TOKEN:api.github.com,github.com"), "names the grant to ask for");
  assert.ok(md.includes("ask the human; do not invent an identity"));
  assert.doesNotMatch(md, /gh repo create|## Secrets|gh api user/);
});

test("PYLON.md of a clone names its remote, and never infers an author from GitHub access", () => {
  const md = renderOverlay(overlay)[2]!.content;
  assert.ok(md.includes("is a clone of git@github.com:ramtin/acme-web.git, on branch main from origin/main"));
  assert.ok(md.includes("ask the human; do not invent an identity"));
  assert.doesNotMatch(md, /gh repo create|## Secrets|GH_TOKEN/);

  const granted = renderOverlay({ ...overlay, secrets: [githubTokenGrant, { name: "STRIPE_KEY", hosts: ["api.stripe.com"] }] })[2]!.content;
  for (const fact of ["Nexus has no git identity configured", "- GH_TOKEN: api.github.com, github.com\n", "- STRIPE_KEY: api.stripe.com\n"]) {
    assert.ok(granted.includes(fact), `PYLON.md mentions ${JSON.stringify(fact)}`);
  }
  assert.doesNotMatch(granted, /gh repo create|ask the human which name/);
});

test("a secret grant names an upper-case variable and sends it to hostnames of two labels or more", () => {
  assert.ok(secretNamePattern.test("GH_TOKEN"));
  assert.ok(secretHostPattern.test("api.github.com"));
  assert.ok(!secretNamePattern.test("gh_token"), "a lower-case name");
  assert.ok(!secretHostPattern.test("localhost"), "a single-label host");
});
