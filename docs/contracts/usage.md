# Nexus contracts: usage

Status: agreed on 2026-10-22. A first slice is implemented: the planner, the probe's job and observe routes, and the Docker test backend. The types are in [`src/protocol/`](../../src/protocol), [`src/reconcile.ts`](../../src/reconcile.ts), [`src/backend.ts`](../../src/backend.ts), [`src/services-file.ts`](../../src/services-file.ts), [`src/spawn.ts`](../../src/spawn.ts), [`src/project.ts`](../../src/project.ts), [`src/images.ts`](../../src/images.ts) and [`src/control/templates.ts`](../../src/control/templates.ts). The reasons are in [rationale.md](rationale.md).

The control plane decides every lifecycle step. A probe runs explicit jobs and reports what it sees. A probe never dials the control plane, never decides to wake, pause or move a pylon, and writes no durable Nexus record. Every record in SQLite has one writer, the control plane.

## Contract 1. Probe

### What a probe accepts

A probe serves HTTP on its tailnet address, port 7480. Tailnet identity is the only authentication, and the home tailnet's policy stays unchanged, with no tags and no ACL edits. The probe asks its local `tailscaled` who the peer is (LocalAPI `whois`) and compares the peer's stable node ID with the one its config names for the route (`routeAuth` and `ProbeAuthConfig` in [`src/protocol/routes.ts`](../../src/protocol/routes.ts)).

| Route | Caller | Purpose |
|---|---|---|
| `PUT /v1/jobs/{jobId}` | Control plane (`rj-firebat`) | Submit one lifecycle job. Safe to repeat with the same `jobId` |
| `GET /v1/jobs/{jobId}` | Control plane (`rj-firebat`) | Read a job's status, or 404 after a probe restart |
| `GET /v1/observe` (NDJSON stream) | Control plane (`rj-firebat`) | A snapshot of the node, then events |
| `POST /v1/pylons/{id}/commands` | Control plane (`rj-firebat`) | Synchronous guest commands: exec, open or close a session or drop a failed one, service operations, linking a listening port as a preview |
| `PUT /v1/secrets/{name}` | Control plane (`rj-firebat`) | Hand the probe a secret the control plane holds, today only `NEXUS_CHATGPT_TOKEN`, the harness's ChatGPT access token. The probe keeps it in memory and updates every running pylon that has the grant. Sent every minute, changed or not |
| `GET /v1/pylons/{id}/stream` (WebSocket) | Control plane (`rj-firebat`) | A raw byte stream to a program in the pylon, for the harness channel and, through a pty relay, terminal attach |
| `GET /v1/manifests/{artifactId}` | Control plane (`rj-firebat`) | The manifest of an image or template the node holds, or 404. The control plane records a built image from it |
| `GET /v1/artifacts/{artifactId}?sha256=` | The other probe | Probe-to-probe copies of images and templates: the manifest in a header, then the archive, which the fetching probe verifies before use. A probe holding other bytes under the ID refuses with 409 and its reason, before it sends any. A checkpoint stays on its node |

Lifecycle jobs are Amp's `spawn`, `pause` and `delete`, plus `build-image`, `build-template`, `fetch-artifact` and `drop-artifact`. A job expires 30 seconds after it was issued if the probe has not accepted it. Once accepted, it has a fixed deadline: 5 minutes for Amp's three, and 30 minutes for builds and copies. The probe runs at most one job per subject (a pylon or an artifact) and answers `busy` to a second one. `drop-artifact` cannot name a checkpoint. A `spawn` with `relaunch: false` boots without bringing the pylon's sessions back and leaves them for the next spawn, and the probe reports no `liveHash` for the pylon it booted. A probe that takes it says `spawnsWithoutRelaunch: true` in its snapshot, and one older ignores the field.

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

`planPylon` is pure. It reads the desired phase (derived from the thread and its activity), the probe's last observation and any job in flight, and returns one step. The tick runs on every observation event and every 5 seconds. A pylon a probe reports that the registry does not know is an orphan. `nexus nodes` and the dashboard list it from the probe's observation, and only a human deletes it.

### Call site: opening a terminal from the dashboard

```ts
const pane = await probes.get(node).command(pylonId, {
  kind: "open-session", harness: "claude-code", title: "review",
});
const terminal = await openTerminal(
  (argv) => probes.get(node).stream(pylonId, argv), terminalSize(120, 40), "xterm-256color", ["herdr", "--session", "nexus"],
);
for await (const bytes of terminal) browserSocket.send(bytes);
```

A stream is a raw pipe, with no pty. `openTerminal` (`src/guest-terminal.ts`) runs a small pty relay in the guest with `python3`, and frames keys and resizes on its stdin, so the probe and every backend stay unaware of terminals. The control plane's attach route (`src/control/attach.ts`) serves such a terminal to `nexus attach` as a WebSocket. Every guest command and stream runs as `user`. A root command is `["sudo", ...]`. The harness channel uses the same `stream` call with the pi-env remote daemon as `argv`. When the connection drops, `bytes.done` resolves to `lost`, and pi-durable reports the tool as interrupted.

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

The schema starts from pi-sandbox's `services` schema, and `parseServicesFile` in `src/services-file.ts` is its one parser: a real pylon, the Docker backend and the in-pylon API all accept exactly the same files. The file holds only `services`. A `cwd` is a relative path inside the repo. `PUBLIC_URL` is the `https://` tailnet address of the preview. `PORT`, `PUBLIC_URL` and every `NEXUS_*` name are managed, and a service may not set them. A service runs in a login shell, which sets Nexus's own `NEXUS_*` names again over any value the file gives. A fixed `port` may not be one of Nexus's own, 22 for sshd or 700 to 799 for the preview relay, and a file that fixes one is refused whole, as one with a duplicate fixed port is. A pylon that refuses the file starts none of its services, and reports why as a `services` startup failure.

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
nexus services ensure --json               # start what .nexus/services.yaml declares now, wait for health and preview URLs
nexus service logs web --lines 200
nexus service restart web
nexus service start storybook --command "pnpm storybook --port \$PORT" --preview
nexus preview 6006 --title Storybook       # publish a port that is already listening
nexus unpreview 6006                       # stop publishing it
nexus output add file artifacts/screenshot.png --title "Checkout page"
nexus output add diff                      # snapshot the working tree as a diff output
```

Nexus starts each declared service on its own: at every boot and wake, and within about 10 s of the node's next read for one added while the pylon runs, a service with a preview once its URL is assigned. `nexus services ensure` is for starting now and waiting for health. A running service keeps the command and env it started with until `nexus service restart`, and a service removed from the file keeps running until an ensure or restart prunes it.

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
nexus image build              # build-image job on the image build node, recorded once its smoke boot passes
nexus image rollout <image>    # fetch-artifact to every other online node, then current once all hold it
```

The recipe lives in this repo under `images/pylon/`, and the control plane builds the recipe of the release it runs. Each file carries its mode as git checks it out, 0755 when executable and 0644 otherwise, and the build writes it with that mode whatever the build node's umask. The hash of the files, their modes and the pins is the image ID, so rebuilding unchanged inputs is a no-op. A build changes nothing pylons use. The rollout makes the image current only once every online node holds it, and `nexus image rollback` returns to the image current before. Running and paused pylons keep the image they booted from.

### Refreshing the pylon's agent setup

The image bakes the Claude Code plugins, skills, pi packages, pi extensions and pi-shepherdr profiles this Mac runs, from `images/pylon/agent-setup/manifest.json`. The manifest names refs, never file contents: the dotfiles repo and each Claude Code marketplace at a commit, and each plugin and npm package at its exact version. The capture on the Mac writes it:

```sh
node src/agent-setup.ts --dry-run                  # what would ship, what is left out and why, and the image ID it gives
node src/agent-setup.ts                            # writes the manifest, and nothing else
node src/agent-setup.ts --leave-out skill:drafts   # leave one item out for this run, by <kind>:<name>
```

It reads `~/.claude`, `~/.pi` and `~/.agents`, and the dotfiles repo they link into. It shows that each pinned commit is on its remote with `git ls-remote`, the clone's own history, or GitHub's compare API, and never fetches, so it writes nothing outside the nexus checkout. Running it twice on an unchanged Mac writes the same bytes, so the image ID does not move. It never moves `images/pylon/pins.json`. Nexus's hooks and transcript reader depend on how the pinned Claude Code and pi versions behave, so moving one is its own change, checked and reviewed on its own, not a side effect of a refresh. When this Mac runs another version than the pin, the capture says so in a note, such as `this Mac runs Claude Code 2.1.310 and the image pins 2.1.308 (pins.json is yours to change)`. Move the pin by editing `pins.json`, which changes the image ID like any recipe change. The leave-outs it always applies, each printed with its reason, are in `leaveOuts` in [`src/agent-setup.ts`](../../src/agent-setup.ts): the Nexus plugin and the pi-nexus package, which are recursive inside a pylon, and the skills and pi extensions that work only on the Mac. A skill that `skillOverrides` turns off for Claude Code goes to pi only. Each directory of `~/.pi/agent/shepherdr/profiles/` ships from the dotfiles repo like a skill, and the image installs exactly those profiles, so pi-shepherdr adds none of its bundled ones. A profile whose `prompt` or `prepare` is not a file in its directory, whose `pi_args` names an absolute or `~` path, whose `prepare` file, or a module it imports, imports anything but a `node:` module or a file in its directory, or that holds a link leading anywhere but a file in its directory is refused. A pylon's pi is signed in only as the `openai` provider, so the installer rewrites a profile's `openai-codex/` model to `openai/`. Leave one out with `--leave-out shepherdr-profile:<name>`.

When something would ship but the image build could not fetch exactly what this Mac runs, the capture writes nothing, lists every problem and exits 1:

```text
  skill ramtin-mode: mac-config/mac-dotfiles/claude/.claude/skills/ramtin-mode is not committed in /Users/you/dotfiles
  claude plugin notes-compaction@claude-mods: the installed copy differs from marketplace claude-mods at b97e1e3. Run `claude plugin update notes-compaction@claude-mods`, then capture again
  dotfiles: HEAD 9ba7de9 is not shown to be on https://github.com/you/dotfiles (no branch or tag there is it or a descendant this clone has), so the image build may not fetch it. Push it, or fetch so this clone knows origin's branches
Wrote nothing: 3 problems above.
```

Commit and push the manifest, then build the image as [the deploy guide](../../deploy/README.md) describes. The build fetches what the manifest pins, installs it as `user`, and fails on any difference from the manifest. Its smoke boot checks the installed setup against the manifest in the recipe and starts pi offline to prove every extension loads. Pylons start pi with `PI_OFFLINE=1` and Claude Code without its official marketplace, because neither can reach the network to update. The review-pane mod's review command needs Neovim 0.10 or later, so the image pins a Neovim release in `pins.json` and the smoke boot checks its version. The exa extensions need a project that grants `EXA_API_KEY` to `api.exa.ai`. The Shepherdr mod and pi-shepherdr ship, because the workers they spawn are Herdr panes in the same pylon, not Nexus threads.

### Call site: starting a thread picks or builds a template

Templates mirror a remote, so only a `RemoteProject` (a project whose `repoUrl` is not null) has one. A scratch project's threads always boot fresh.

```ts
const inputs = await mirror.setupInputs(project, commit === undefined ? { branch } : { commit }); // src/control/mirror.ts, no pylon booted
const key = { project: project.id, image: settings.current, setupHash: setupHashOf(project, inputs) };
const choice = chooseTemplate(project, key, { branch, commit: inputs.commit }, registry.templates(project.id), node, registry.node(node)?.observation?.artifacts ?? [], clock.now());
// reuse a template the node holds, booting at inputs.commit | build on node and boot fresh | fresh while one builds | fresh after a failed build
```

### Call site: spawning on a node that lacks an artifact

```ts
// Inside planPylon: the image and template the boot needs, dependencies first.
const missing = requiredArtifacts(boot).filter((id) => !input.nodeArtifacts.has(id));
// Each missing one becomes a fetch-artifact job from input.holders(id)[0], one per tick, before the spawn.
```
