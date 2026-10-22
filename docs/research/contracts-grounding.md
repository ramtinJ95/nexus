# Grounding for the Nexus contracts

This file collects the facts the contract designers need. Read [the Nexus design](../design.md) and [the data model](../data-model.md) first. Spike evidence is in [`spikes/RESULTS.md`](../../spikes/RESULTS.md).

Nothing here is built yet. Nexus lives at `/Users/ramtin/personal/nexus`.

## Fixed decisions

- Nexus copies Amp Orbs as closely as possible and uses no Amp service.
- Names: Nexus is the control plane and dashboard. A pylon is one microVM, Amp's "orb". A probe is the node agent on each machine.
- One pi-durable harness on the control plane runs every thread's agent loop and holds model credentials.
- A thread is one pi-durable conversation plus one pylon. Every thread belongs to a project, and a project is one git repository.
- Pylons are owned by threads only. One fresh pylon per thread, deleted with the thread. The pylon record stores its thread so named pylons can be added later.
- Herdr runs every interactive session inside a pylon: Claude Code, pi, or a shell. Nexus never uses tmux.
- Waking a pylon relaunches each recorded session into its prompt, for example `claude --resume <id>`. It never continues work automatically.
- Nodes: `rj-firebat` (AMD Ryzen 7 255, 22 GiB, main node, runs the control plane) and `infra-testbench` (Intel i9-9880H, 31 GiB). Both are on the home tailnet. More nodes may come later.
- Each pylon gets its own Claude and OpenAI login for now. Credentials never go into templates.
- pi and Claude Code dotfiles go into every pylon in two layers: a common layer and a pylon overlay. The resume hook pulls the latest dotfiles.
- Outputs are a typed list: `branch`, `diff`, `preview`, `file`.
- Previews are published per node with `tailscale serve`.

## Amp's documented contracts

### Self-hosted orb provider

Source: https://ampcode.com/docs/orbs/self-hosted and https://ampcode.com/news/self-hosted-orbs, released 2026-10-22.

- You run `amp orb provider ./dispatch.sh` under a service manager. Amp sends it jobs over outbound HTTPS. Amp never connects inward.
- The provider runs the dispatch program once per job with no arguments. Parameters arrive as environment variables: `ORB_OPERATION` (`spawn`, `pause`, or `delete`), `ORB_ID` (`amp-<thread id>`), `ORB_IMAGE`, `ORB_SNAPSHOT_ID`, `ORB_TOKEN` (spawn only, short-lived), and `AMP_URL`.
- Every operation must be safe to repeat and must finish within 5 minutes.
- Pause: Amp sends a pause with `ORB_SNAPSHOT_ID`, then later a spawn with the same snapshot ID. The program stores the copy and boots from it. If the platform cannot keep the disk, it deletes the orb instead and Amp reruns repository setup.
- Example backends: Docker (`docker run --init -d ... sleep infinity`, then `docker exec -d ... amp orb bootstrap`, pause with `docker stop`, snapshot with `docker commit`), E2B (pause keeps memory and disk), Modal (filesystem snapshot), Apple `container`, Vercel, Daytona, exe.dev.
- Kubernetes: a Helm chart runs a spawner container (`amp orb provider`) and a provider container that drives Google's Agent Substrate, which uses gVisor or Cloud Hypervisor sandboxes with RAM and disk snapshots. Paused disks go to object storage so an orb resumes on any worker.
- Model inference and the agent loop run on Amp's servers. The orb runs tools and keeps the checkout, build output, and saved disks.
- The orb connects out to Amp for bootstrap and tool connections, and to `tunnel.ampcode.com` for portals, Terminal, and Desktop.
- Image contract: Linux x64 with glibc, so Alpine does not work. It needs bash, coreutils, util-linux, CA certificates, git 2.34 or later, `/usr/local/bin/amp`, and a `user` account with a writable `/home/user` and passwordless sudo. Portals need Node 18 or later. The terminal needs tmux 2.9 or later. The checkout is at `/home/user/workspace/repo`.
- A provider can turn off Amp's cloning and credential setup and supply its own checkout and git credential helper.

### Project configuration

Source: https://ampcode.com/docs/orbs/customizing and https://ampcode.com/docs/orbs/portals.

- `.agents/setup` is an executable, idempotent script. It has a 20-minute limit, must not leave processes running, and gets no personal GitHub credentials. A failed setup publishes no snapshot.
- After a successful setup Amp takes a project snapshot and reuses it for up to 72 hours. Editing `.agents/setup` does not invalidate a cached snapshot.
- `.agents/resume` runs after activation and on every wake. Amp waits 10 seconds, then lets it continue in the background. It must not install dependencies.
- Project settings can also hold a pre-clone script and a pre-setup script, so setup can work without a commit.
- `.amp/services.yaml` is committed to the repo. Generated state in `.amp/portals/*.json` is gitignored.
  - It has a top-level `services:` map. Names are 1 to 32 lowercase letters, digits, or hyphens.
  - Fields: `command` (required, run through a login shell), `cwd`, `port`, `env`, `health` (HTTP path, 2xx or 3xx means ready), `portal`, `portals` (folders allowed one level deep), `review` (default `true`), and `platforms` (`linux`, `darwin`).
  - A service with a portal must listen on `$PORT`. Amp manages `PORT`, `PUBLIC_URL`, and `AMP_THREAD_ID`, and `env` cannot set them.
  - `${services.web.publicURL}` references another service's URL. That service must have a portal. Cycles are rejected.
- Agent-facing commands inside an orb: `amp orb services ensure [--json]`, `amp orb service list|status|logs|restart|stop <name>`, `amp orb service start <name> --command ... --portal`, `amp orb portal <port>`, `amp orb id-token`, `amp orb restart-processes`.
- Secrets are environment variables layered personal over project over workspace and masked in output. OIDC tokens come from `amp orb id-token --audience <svc>`.
- Lifecycle: an orb pauses when the agent has been idle for 5 minutes and no human has interacted for 20 minutes. Archiving a thread pauses it at once. Opening the thread, sending a message, or hitting a portal wakes it. Deleting the thread deletes the orb.

## What pi-sandbox already does

The source is at `/Users/ramtin/personal/howaboua-pi-stuff/packages/pi-sandbox` (MIT). Read `README.md`, `AGENTS.md`, and the files below.

- `src/client.ts` exports `run(action, cwd, signal)`. It runs every lifecycle action against a per-instance controller. `scripts/setup-repo-sandbox.mjs` in the same repo drives it from code. Read it with `git -C /Users/ramtin/personal/howaboua-pi-stuff show HEAD:scripts/setup-repo-sandbox.mjs`.
- `src/daemon.ts` is the per-instance controller. It is a detached Node process that outlives Pi sessions and serves HTTP on `control.sock`. Lifecycle actions run in one queue. `exec`, `read`, `write`, `logs`, and `inspect` bypass the queue.
- `src/runtime.ts` boots a Gondolin VM, resumes from `disk.qcow2` if one exists, runs setup on a fresh disk with a 20-minute deadline, runs resume hooks with a 10-second wait, and reconciles services with `ensure`. Stop closes previews and SSH, stops services, syncs, and writes a disk checkpoint to `disk.next.qcow2` before a rename.
- `src/contracts.ts` holds the YAML config schema and the action schema. The YAML has `profile`, `resources`, `diskGiB`, `workspace`, `image`, `network.allowedHosts`, `setup`, `resume`, and `services`. The services schema mirrors Amp's, with `preview` and `previews` in place of `portal` and `portals`, and `health: process` added. It rejects `review: true`, `AMP_THREAD_ID`, and `$AMP_USER_EMAIL`.
- `src/services.ts` assigns sticky ports, routes Gondolin ingress by `/<service>/` prefix, and opens one localhost proxy per service.
- `src/processes.ts` holds detached exec handles.
- State lives under `$PI_SANDBOX_HOME` in `instances/<name>/` or `templates/<name>/`, as `record.json`, `intent.json`, `status.json`, `disk.qcow2`, `services.json`, and `controller.log`.
- `prepare` runs setup and saves a template without starting services. `create` with `template` copies the template's `disk.qcow2`.
- pi-sandbox passes only `allowedHosts` to Gondolin. It does not pass `secrets`.
- Its AGENTS.md: use supported Gondolin APIs only, never stop instances on Pi shutdown, and treat runtime state and disk paths as durable contracts.

## Gondolin facts

Source: `/Users/ramtin/personal/howaboua-pi-stuff/packages/pi-sandbox/node_modules/@earendil-works/gondolin` (0.13.0) and https://earendil-works.github.io/gondolin/.

- `VM.create(options)`, `vm.start()`, `vm.exec()`, `vm.fs`, `vm.enableIngress()`, `vm.setIngressRoutes()`, `vm.enableSsh()`, `vm.checkpoint(path)`, and `VmCheckpoint.load(path).resume(options)`.
- `createHttpHooks({ allowedHosts, secrets })` allows HTTP and TLS only to listed hosts. The guest sees placeholders, and the host substitutes the real values in outbound headers for allowed hosts. Bodies are never rewritten. SSH egress can be terminated on the host with a host-side key or agent. Everything else is blocked. There is no UDP.
- Gondolin 0.13 has no callback for denied hosts. Denials only appear in hook logs.
- Checkpoints are disk only, as qcow2 with a metadata trailer. Resume boots a new VM on a copy-on-write overlay. Memory does not survive.
- Ingress is an HTTP/1.1 gateway on the host, routed by path prefix, with no authentication.
- `gondolin build` takes a JSON config. With `distro: "alpine"` plus `oci.image`, it uses Alpine boot artifacts (kernel and initramfs) with the OCI image as the root filesystem. It needs Docker or Podman to export the OCI image.

## Spike findings

These come from `spikes/RESULTS.md`, run on `infra-testbench` on 2026-10-22.

- **S1, Debian pylon image.** It passes with a workaround. Gondolin 0.13.0's OCI build aborts while copying Alpine kernel modules. `dist/src/alpine/kernel-modules.js:45-50` calls `fs.cpSync` without `verbatimSymlinks`, which follows `vmlinuz -> /boot/vmlinuz-virt` to the host's unreadable `/boot`. The workaround seeds the unchanged module tree with `postBuild.copy` into `/lib/modules`. It is tied to the kernel version. The build took 35 s and a cold boot took 3.9 s. The image provisioned as guest root after boot: user `user` (UID 1000), Node 24.22.1, Claude Code 2.1.308, Herdr 0.9.5 (official installer), Python 3, Bash, and `openssh-server`. The build user needs Docker access.
- **S2, TLS interception.** It passes for requests without a login. A non-root user cannot read `/etc/gondolin/mitm/ca.crt` through its FUSE mount, so the image uses `NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt`. `vm.enableSsh()` needs a real `sshd`. Resume to first exec took 5.4 s.
- **S3, pi-durable.** A scripted model drove pi-durable's own `bash` tool inside a Gondolin VM. Cold boot took 3.9 s and the tool round took 63 ms. `ExecutionEnv` comes from `@earendil-works/pi-durable/env` and extends `FileSystem` and `Shell`. It covers path resolution, text and binary reads, line and range readers, writes, renames, metadata, watchers, temp files, and `exec` with `Result` values, spill files, and abort signals. A minimal adapter over `vm.exec` and `vm.fs` only proves the round trip. `@earendil-works/pi-env` 1.4.0 ships a Rust remote daemon and `RemoteExecutionEnv` over a `Connection`, with SSH deployment. Running it through Gondolin is untested. `registerEnvConformance` and `createEnvConformance` come from `@earendil-works/pi-durable/testing`. pi-durable is at 1.4.0 and is labelled experimental.
- **S4, previews.** `tailscale serve --bg --https=8443 http://127.0.0.1:<port>` worked without sudo, and HTTP/2 returned 200 to the Mac in 0.4 s. The guest received `tailscale-user-login` and `tailscale-user-name`. The guest saw `x-forwarded-proto: http`. The first HTTPS request timed out after 15 s, and the retry passed.
- **S5, pi with a ChatGPT login.** It passes. Browser login fails because the `1455` callback listens inside the guest. Device-code login, or pasting the redirect URL, works. pi 1.4.0 needs `auth.openai.com`, `chatgpt.com`, and `api.openai.com`.
- **Hosts the image build needed.** `deb.debian.org`, `nodejs.org`, `herdr.dev`, `github.com`, `release-assets.githubusercontent.com`, and `registry.npmjs.org`.

## Reusable code in howaboua-pi-stuff

The checkout at `/Users/ramtin/personal/howaboua-pi-stuff` is sparse. Read files that are not on disk with `git show HEAD:<path>`.

- `packages/pi-shepherdr/src/herdr-client.ts`: an NDJSON client for Herdr's Unix socket, with `events.subscribe` streaming.
- `packages/pi-shepherdr/src/launch.ts`: `agent.start` in a new tab, polling until the agent is ready, and rollback on failure.
- `packages/pi-shepherdr/src/monitor-events.ts` and `src/settlement.ts`: event-driven `idle`, `working`, `blocked`, and `done` status.
- `packages/pi-shepherdr/src/remote/shepherdr-session.mjs`: a bounded backwards reader for pi JSONL sessions.
- `packages/pi-shepherdr/src/peer-inbox.ts`: a token-authenticated loopback inbox that steers a running pi turn or queues the next one.
- `herdr integration install pi` writes `herdr-agent-state.ts` into pi so Herdr knows pi's status.
