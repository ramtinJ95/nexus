# Nexus contracts: usage

Status: agreed on 2026-10-22. A first slice is implemented: the planner, the probe's job and observe routes, and the Docker test backend. The types are in [`src/protocol.ts`](../../src/protocol.ts), [`src/reconcile.ts`](../../src/reconcile.ts), [`src/backend.ts`](../../src/backend.ts), [`src/project.ts`](../../src/project.ts) and [`src/images.ts`](../../src/images.ts). The reasons are in [rationale.md](rationale.md).

The control plane decides every lifecycle step. A probe runs explicit jobs and reports what it sees. A probe never dials the control plane, never decides to wake, pause or move a pylon, and writes no durable Nexus record. Every record in SQLite has one writer, the control plane.

## Contract 1. Probe

### What a probe accepts

A probe serves HTTP on its tailnet address, port 7480. Tailnet identity is the only authentication, and the home tailnet's policy stays unchanged, with no tags and no ACL edits. The probe asks its local `tailscaled` who the peer is (LocalAPI `whois`) and compares the peer's stable node ID with the one its config names for the route (`routeAuth` and `ProbeAuthConfig` in [`src/protocol.ts`](../../src/protocol.ts)).

| Route | Caller | Purpose |
|---|---|---|
| `PUT /v1/jobs/{jobId}` | Control plane (`rj-firebat`) | Submit one lifecycle job. Safe to repeat with the same `jobId` |
| `GET /v1/jobs/{jobId}` | Control plane (`rj-firebat`) | Read a job's status, or 404 after a probe restart |
| `GET /v1/observe` (NDJSON stream) | Control plane (`rj-firebat`) | A snapshot of the node, then events |
| `POST /v1/pylons/{id}/commands` | Control plane (`rj-firebat`) | Synchronous guest commands: exec, open or close a session or drop a failed one, service operations, linking a listening port as a preview |
| `GET /v1/pylons/{id}/stream` (WebSocket) | Control plane (`rj-firebat`) | A byte stream into the pylon, for terminal attach and the harness channel |
| `GET /v1/artifacts/{artifactId}?sha256=` | The other probe | Probe-to-probe copies of images and templates: the manifest in a header, then the archive, which the fetching probe verifies before use. A probe holding other bytes under the ID refuses with 409 and its reason, before it sends any. A checkpoint stays on its node |

Lifecycle jobs are Amp's `spawn`, `pause` and `delete`, plus `build-image`, `build-template`, `fetch-artifact` and `drop-artifact`. A job expires 30 seconds after it was issued if the probe has not accepted it. Once accepted, it has a fixed deadline: 5 minutes for Amp's three, and 30 minutes for builds and copies. The probe runs at most one job per subject (a pylon or an artifact) and answers `busy` to a second one. `drop-artifact` cannot name a checkpoint.

### Call site: the reconcile tick on the control plane

```ts
import { planPylon, envelope } from "./reconcile.ts";

for (const pylon of registry.livePylons()) {
  const step = planPylon(registry.planInput(pylon.id), clock.now());
  if (step.kind !== "submit") continue;
  const env = envelope(step.job, pylon.node, clock.now());
  const reply = await probes.get(pylon.node).submit(env);
  registry.recordSubmission(pylon.id, env, reply); // busy and expired wait for the next tick
}
```

`planPylon` is pure. It reads the desired phase (derived from the thread and its activity), the probe's last observation and any job in flight, and returns one step. The tick runs on every observation event and every 5 seconds. A pylon a probe reports that the registry does not know becomes an orphan record, and only a human deletes it.

### Call site: opening a terminal from the dashboard

```ts
const pane = await probes.get(node).command(pylonId, {
  kind: "open-session", harness: "claude-code", title: "review",
});
const bytes = await probes.get(node).stream(pylonId, {
  pty: { cols: 120, rows: 40 }, argv: ["herdr", "--session", "nexus"],
});
browserSocket.pipe(bytes).pipe(browserSocket);
```

Every guest command and stream runs as `user`. A root command is `["sudo", ...]`. The harness channel uses the same `stream` call with `pty: null` and the pi-env remote daemon as `argv`. When the connection drops, `bytes.done` resolves to `lost`, and pi-durable reports the tool as interrupted.

### Call site: the probe running a job against its backend

```ts
// The probe's whole job runner is a switch over Job["kind"].
const signal = AbortSignal.timeout(jobDeadlineMs[env.job.kind]);
await runJob(env.job, deps, signal); // deps: backend, node secrets, tailscale serve, peer fetch
```

## Contract 2. Project config

### In the repo

```
.nexus/setup           executable, idempotent, 20-minute limit, runs as user once per template
.nexus/resume          executable, runs as user on every boot. Nexus waits 10 s, then lets it continue
.nexus/services.yaml   supervised services and previews
```

```yaml
# .nexus/services.yaml
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
      API_URL: ${services.api.publicURL}
```

The schema starts from pi-sandbox's `services` schema. `PUBLIC_URL` is the `https://` tailnet address of the preview. `PORT`, `PUBLIC_URL` and every `NEXUS_*` name are managed.

### In Nexus

```ts
await nexus.projects.create({
  id: "acme-web",
  repoUrl: "git@github.com:ramtin/acme-web.git",
  defaultBranch: "main",
  defaultNode: "rj-firebat",
  resources: { cpus: 4, memoryGiB: 8, diskGiB: 20 },
  allowedHosts: ["registry.npmjs.org", "api.stripe.com"],
  secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }],
  logins: ["claude", "chatgpt"], // adds each login's hosts to the allowlist
  preSetup: null,
});
```

Secret values never reach the control plane or a template. Each node holds them in its own secret file. A pylon sees a placeholder.

A scratch project has no repository. Its threads start from `git init` on `defaultBranch`, and a GitHub grant lets the agent publish what it makes:

```ts
await nexus.projects.create({
  id: "sketchpad",
  repoUrl: null, // scratch: nothing is cloned, and nothing is kept once a thread is deleted
  defaultBranch: "main", // the empty repository's first branch
  defaultNode: "infra-testbench",
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 },
  allowedHosts: [],
  secrets: [githubTokenGrant], // GH_TOKEN to api.github.com and github.com
  logins: ["claude"],
  preSetup: null,
});
```

Starting a thread decides its repository once and freezes it into the pylon's boot:

```ts
const repo: RepoInit = hasRemote(project)
  ? { kind: "clone", url: project.repoUrl, checkout: { branch, commit: request.commit ?? `origin/${branch}` } }
  : { kind: "empty", branch }; // a commit asked of a scratch project is a 400
```

### Inside a pylon

The agent finds `NEXUS_PYLON_ID` in its environment and `~/.nexus/PYLON.md` imported by its Claude Code and pi instructions. The image wires the import: `~/.claude/CLAUDE.md` holds `@~/.nexus/PYLON.md`, and `~/.pi/agent/AGENTS.md` is a link to it, because pi's instructions have no import. That file names the thread, the reachable hosts, each preview URL and these commands:

```sh
nexus info --json                          # pylon, thread, node, previews, allowed hosts
nexus services ensure --json               # start what .nexus/services.yaml declares, wait for health and preview URLs
nexus service logs web --lines 200
nexus service restart web
nexus service start storybook --command "pnpm storybook --port \$PORT" --preview
nexus preview 6006 --title Storybook       # publish a port that is already listening
nexus unpreview 6006                       # stop publishing it
nexus output add file artifacts/screenshot.png --title "Checkout page"
nexus output add diff                      # snapshot the working tree as a diff output
```

Branches, pushed branches, dirty trees and running previews become outputs without any command.

In a scratch pylon, PYLON.md also says how to commit and publish. With the GitHub grant, the agent runs:

```sh
cd ~/workspace/repo                        # `git init` on main: no commits, no remote
git config --global user.name "$(gh api user --jq .login)"
git config --global user.email "$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
git add -A && git commit -m "feat: first version"
gh repo create <owner>/<name> --private --source . --remote origin --push
git push                                   # later pushes: git asks gh for the token, which reads this boot's GH_TOKEN
nexus output add diff                      # works before the first commit too: the diff is against the empty tree
```

## Contract 3. Template images

### Building and shipping the base image

```sh
nexus image build   # build-image job on the image build node. Passing its smoke boot makes it current
```

The recipe lives in this repo under `images/pylon/`. Its content hash is the image ID, so rebuilding unchanged inputs is a no-op. After a successful build, the control plane sends `fetch-artifact` to every other online node. Running and paused pylons keep the image they booted from.

### Refreshing the pylon's agent setup

The image bakes the Claude Code plugins, skills, pi packages and pi extensions this Mac runs, from `images/pylon/agent-setup/manifest.json`. The manifest names refs, never file contents: the dotfiles repo and each Claude Code marketplace at a commit, and each plugin and npm package at its exact version. The capture on the Mac writes it:

```sh
node src/agent-setup.ts --dry-run                  # what would ship, what is left out and why, and the image ID it gives
node src/agent-setup.ts                            # writes the manifest, and nothing else
node src/agent-setup.ts --leave-out skill:drafts   # leave one item out for this run, by <kind>:<name>
```

It reads `~/.claude`, `~/.pi` and `~/.agents`, and the dotfiles repo they link into. It shows that each pinned commit is on its remote with `git ls-remote`, the clone's own history, or GitHub's compare API, and never fetches, so it writes nothing outside the nexus checkout. Running it twice on an unchanged Mac writes the same bytes, so the image ID does not move. The leave-outs it always applies, each printed with its reason, are in `leaveOuts` in [`src/agent-setup.ts`](../../src/agent-setup.ts): the Nexus and Shepherdr plugins and pi packages, which are recursive inside a pylon, and the skills and pi extensions that work only on the Mac. A skill that `skillOverrides` turns off for Claude Code goes to pi only.

When something would ship but the image build could not fetch exactly what this Mac runs, the capture writes nothing, lists every problem and exits 1:

```text
  skill ramtin-mode: mac-config/mac-dotfiles/claude/.claude/skills/ramtin-mode is not committed in /Users/you/dotfiles
  claude plugin notes-compaction@claude-mods: the installed copy differs from marketplace claude-mods at b97e1e3. Run `claude plugin update notes-compaction@claude-mods`, then capture again
  dotfiles: HEAD 9ba7de9 is not shown to be on https://github.com/you/dotfiles (no branch or tag there is it or a descendant this clone has), so the image build may not fetch it. Push it, or fetch so this clone knows origin's branches
Wrote nothing: 3 problems above.
```

Commit and push the manifest, then build the image as [the deploy guide](../../deploy/README.md) describes. The build fetches what the manifest pins, installs it as `user`, and fails on any difference from the manifest. Its smoke boot checks the installed setup against the manifest in the recipe and starts pi offline to prove every extension loads. Pylons start pi with `PI_OFFLINE=1` and Claude Code without its official marketplace, because neither can reach the network to update. The review-pane mod's review command needs Neovim 0.10 or later, so the image pins a Neovim release in `pins.json` and the smoke boot checks its version. The exa extensions need a project that grants `EXA_API_KEY` to `api.exa.ai`.

### Call site: starting a thread picks or builds a template

Templates mirror a remote, so only a `RemoteProject` (a project whose `repoUrl` is not null) has one. A scratch project's threads always boot fresh.

```ts
const inputs = await mirror.setupInputs(project, thread.branch); // the control plane's bare mirror, no pylon booted
const key = { project: project.id, image: settings.current, setupHash: setupHashOf(project, inputs) };
const choice = chooseTemplate(project, key, { branch: thread.branch, commit: inputs.commit }, registry.templates(project.id), thread.node, clock.now());
// reuse | build on thread.node | wait for a running build | fresh (boot the image, run setup inline) after a failed build
```

### Call site: spawning on a node that lacks an artifact

```ts
// Inside planPylon: the image and template the boot needs, dependencies first.
const missing = requiredArtifacts(boot).filter((id) => !input.nodeArtifacts.has(id));
// Each missing one becomes a fetch-artifact job from input.holders(id)[0], one per tick, before the spawn.
```
