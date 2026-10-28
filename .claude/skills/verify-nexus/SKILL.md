---
name: verify-nexus
description: Drive a local Nexus stack (control plane, probe, Docker pylons) through its real user surfaces, the Mac `nexus` CLI and the control plane's web dashboard, and capture proof. Use when you need to show a Nexus change works end to end, such as starting a thread, messaging its agent, archiving and waking its pylon, or deleting it, rather than only passing unit tests.
---

# Verify Nexus

Nexus runs coding agents in microVMs called pylons. A thread is one pi-durable conversation plus one pylon. People use it through the Mac `nexus` CLI (`src/cli/nexus.ts`, contract in `docs/cli.md`) and the dashboard that the control plane serves at `/`. Both sit on the JSON API in `src/control/api.ts`. The other surfaces are not mapped here: the in-pylon `nexus` CLI (`images/pylon/nexus`), the probe's HTTP API, and `POST /v1/images`, which records an image built elsewhere. `nexus image build`, `rollout` and `rollback` need a caller in `deployers`, which the stack's only caller, the control plane's own node, never is, so `stack.ts` seeds its Docker image as current in the registry before the control plane starts.

This skill never drives the home-lab deployment on `rj-firebat` and `infra-testbench`. That deployment is the user's real instance. It also sits on the home tailnet, which this machine reaches only through ts-home. Every recipe here runs against a local stack that the skill starts and stops itself.

## The local stack

`scripts/verify-nexus up` starts one process, `scripts/stack.ts`. It uses the same wiring as `src/control/thread-on-node.ts`:

- The real control plane comes from `startControlPlane`: the registry, the reconcile loop, the pi-durable harness, the API and the dashboard. It listens on `http://127.0.0.1:7470`.
- A real probe comes from `startProbe`, on `127.0.0.1:7480`, with the Docker backend (`src/docker-backend.ts`). Each pylon is a container named `pylon-<thread>`, built from an image the stack builds: Node 24, git, Herdr, the pi-env daemon, the in-pylon CLI and a one-commit checkout. The checkout carries `refs/nexus/base` at that commit, which a pylon-vm records on its first boot and the Docker backend never does.
- Only the production boundaries are replaced:
  - tailscaled's whois is a fake LocalAPI socket. It names port 7480 as the probe and every other caller as the control plane's own node, which the API allows.
  - The model is scripted (`src/harness/test-fixture.ts`). A message `bash: <command>` makes exactly one bash tool call in the pylon, then the answer `scripted answer after toolResult`. A message `stream: <n>` gets the answer `word0 word1 ...` of n words, written one word every 20 ms, so it streams as a real model's does. Any other message gets `scripted answer after user`.
  - `tailscale serve` is `src/probe/fake-tailscale.ts`, so the Mac's work tailnet is never touched.
- Seed data, created through the API: image `img-0000000000aa` made current, node `verify-node`, and project `spoon` (Spoon-Knife on `main`, 1 CPU, 1 GiB).

Isolation: one stack per machine. The control plane reaches probes only on port 7480, and containers keep the bridge port they booted with, so all four ports are fixed: 7470 API, 7480 probe, 7481 preview gateway, 7482 in-pylon CLI bridge. `up` refuses to start while any of them is taken or a previous run was not cleaned up. Never drive a stack this skill did not start. If `doctor` fails on a stack you did not start, stop and report it rather than killing it.

All state lives under `<repo>/.verify/nexus/`, which `.gitignore` ignores. A run's scratch state is in `runs/<run>/`, including `stack.log`, the registry and the harness storage. The fake tailscaled socket is in a `/tmp/nexus-verify-*` directory instead, which `socket-dir` names, because a socket path in a long worktree path would pass macOS's 104-byte limit. `down` removes it. A run's evidence is in `evidence/<run>/`. `current` names the run that is up.

## Launch

Prerequisites: Docker Desktop running, Node 26 or newer, `npm ci` and `npm run build` done in the repo, and network access for the first image build, which pulls `node:24-bookworm-slim` and installs Herdr from herdr.dev. The Claude Code sandbox blocks both the Docker socket and local port binding. If a command fails with `permission denied ... docker.sock` or `listen EPERM`, the sandbox stopped it. Hand the run to a worker outside the sandbox, or ask the user to run it with `!`.

```sh
V=.claude/skills/verify-nexus/scripts/verify-nexus   # from the repo root
$V up
```

`up` prints `verify-nexus: ready. API and dashboard at http://127.0.0.1:7470, evidence in <dir>` once the stack is usable. By then the image is built, the probe and the control plane are listening, the seed data is in, and `verify-node` reports `online`. It waits up to 15 minutes, because the first image build is slow. Later builds reuse Docker's layer cache. If the stack dies first, `up` prints the tail of `stack.log` and exits 1. Run `$V down` before trying again.

## Doctor

```sh
$V doctor
```

This is read-only. Each check prints one `ok` or `FAIL` line, and the exit code is 1 when any check fails. A `pylons of this run:` line and any `note` lines are information, not checks. It checks:

- the run's `state.json` exists;
- the recorded pid is still this run's `stack.ts`;
- the stack's pid holds each of the four ports;
- the stack was started from the checkout's current `HEAD`, with a note if the tree was dirty;
- Docker answers and holds the run's pylon image;
- `nexus nodes --json` through the API shows `verify-node` online.

It also lists the run's pylon containers. Run it before driving, and again whenever a result looks wrong. After you change code under `src/`, the running stack is stale. Run `$V down` and `$V up` again: doctor's revision line only catches new commits, not uncommitted edits.

## Drive

Every driver records evidence. Each call writes `NN-<step>.cmd`, `.stdout`, `.stderr` and `.exit` into the run's evidence directory. Then it echoes stdout and stderr and exits with the command's own exit code. The one exception is `$V browser`: playwright-cli exits 0 when an action fails, so a step whose output reports `### Error` exits 1 and records 1. Give each step a short, unique name.

- **Mac CLI**, which is the primary surface. `$V cli <step> -- <nexus args>` runs `node src/cli/nexus.ts` with `NEXUS_URL=http://127.0.0.1:7470` and `NEXUS_SOCKS=none`, which is the documented direct mode. Add `--json` for assertions. Stdout is then one JSON value, and on failure stderr is `{"error","kind","status"}`. Exit codes follow `docs/cli.md`: 0 for ok, 1 failed, 2 unreachable, 3 refused, 4 not-found, 5 conflict, 64 invalid.

  ```sh
  $V cli start -- start --project spoon --title "Proof thread" --json
  $V cli show -- show th-0123456789ab --json
  ```

- **Dashboard.** `$V browser <step> -- <playwright-cli args>` runs the global `playwright-cli` in the browser session `nexus-verify-<run>`, from the evidence directory, so a relative `--filename` saves into it. Open the session first with `$V browser open -- open http://127.0.0.1:7470/`. Targets are Playwright selectors. Prefer the dashboard's stable handles: `#start-dialog`, `#start-title`, `#start-hint`, `#project-dialog`, `#project-id`, `#project-repo`, `#prompt-text`, `#send`, `#archive`, `#unarchive`, `#delete`, `#filter`, `#changes-base`, `#changes-reload`, and `role=link[name="<thread title>"]`. The thread page's inspector shows one tab at a time and remembers it, so select one with `click 'label.seg-tab:has(input[value="changes"])'`, or `previews` or `pylon`, before asserting on it. Take `snapshot` before clicking by ref. The page polls every 5 s, so wait for the state you need rather than sleeping a fixed time.

  ```sh
  $V browser home -- open http://127.0.0.1:7470/
  $V browser home-shot -- screenshot --filename dashboard-home.png
  ```

- **Inside a pylon**, to check side effects only. `$V pylon <step> <thread> -- <cmd...>` runs `docker exec` in `pylon-<thread>`, in `/home/user/workspace/repo`. Use it to confirm what an agent's tool call left on disk. It is not a user path. Never use it to cause the behavior you are proving.

The feature map in [`features/README.md`](features/README.md) holds the recipes. Read it before driving, and follow the matching feature file.

## Evidence

Evidence goes to `.verify/nexus/evidence/<run>/`. `$V evidence` prints the directory. It holds every recorded step, `stack-state.json`, which names the run, the revision, the ports and the seed, and, after `down`, `stack.log`.

Proof standards:

- Exercise the user's path: the CLI or the dashboard. Don't write to the registry, call the backend, or `docker exec` to make something happen. `$V pylon` only observes.
- Capture both the action and the resulting state, such as the `send` reply plus the conversation entry it produced, or a click plus a later snapshot of the page. A final screen alone is not proof.
- Verify side effects alongside what's visible. A tool call's file is on the pylon's disk. A paused pylon has no container and does have a checkpoint image (`docker images --filter label=nexus.verify=<run>`). A deleted thread's container and checkpoints are gone.
- Mocks stand only at the boundaries listed above: whois, the model and `tailscale serve`. A behavior that depends on what those fakes replace, such as real model output, ts-home's SOCKS proxy, tailnet identity, a real MagicDNS preview URL or Gondolin's network policy, is not proven by this stack. Say so in your report rather than claiming it.
- Report each entry point you drove. An entry point you skipped is unverified, even if a sibling entry point passed.

## Cleanup

```sh
$V down
```

`down` stops only this run's stack. It checks that the pid still runs `stack.ts` for this run before it sends SIGTERM, and it uses SIGKILL only if SIGTERM fails for 30 s. Then it:

- closes the run's browser session;
- removes the containers and images labelled `nexus.verify=<run>`: pylons, checkpoints, templates and the pylon image;
- deletes the run's socket directory under `/tmp` and `runs/<run>/`.

It keeps `evidence/<run>/` and copies `stack.log` into it first. It never kills by process name, and it leaves the `node:24-bookworm-slim` base image cached. Run it after every attempt, including failed ones, so the next `up` finds its ports free.

## Helpers

- `scripts/verify-nexus` is the entry point for everything above. Run it with no arguments for usage.
- `scripts/new-project-shots.ts` drives the dashboard's New project flow against its own throwaway control plane with no projects, which the seeded stack cannot show, and asserts each step before its screenshot. Run it with `node .claude/skills/verify-nexus/scripts/new-project-shots.ts`. It needs port 7490 free, local port binding and `playwright-cli`, but not Docker.
- `scripts/live-check` is Nexus's live check: `up`, one thread started, given a tool call, archived, woken with its disk and deleted through the CLI, then `down`. It exits 0 only if every step held. It needs Docker and `jq`, so no verify pylon runs it yet, and Nexus has no `.nexus/verify` that calls it ([docs/design.md](../../../docs/design.md#open-questions)).
- `scripts/stack.ts` is the stack process. `up` starts it, so don't run it by hand. To typecheck it after editing, run `npx tsc -p .claude/skills/verify-nexus/scripts/tsconfig.json`.
