# Nexus design

Nexus runs coding agents inside microVMs on your own Linux machines. Each microVM is called a pylon. Nexus is modelled on Amp Orbs: you start a thread, a fresh pylon boots with the repository and tools ready, and the agent keeps working after your laptop sleeps. You come back later to steer it, open previews of the running app, and collect what it produced.

Status: the first end-to-end slice is built and runs on `infra-testbench`. A thread starts through the control plane API, its pylon boots from a template, the agent runs tools in it, and a declared service is served as a preview on the tailnet. Archiving pauses the pylon, and unarchiving wakes it with its disk and sessions intact. `src/control/thread-on-node.ts` checks that path on a node. `rj-firebat` has not run a thread yet. `nexus session open` and `nexus attach` give a Mac a Claude Code session in a pylon to `/login` in, but a logged-in Claude Code inside a pylon, and its resume after a wake, are not yet proven on a node. The record shapes live in [the data model reference](data-model.md). The probe, project config and template image contracts live in [contracts](contracts/rationale.md).

## Nexus copies Amp's split between the agent loop and the machine

Amp runs model inference and the agent loop on its own servers. The orb only executes tools and holds the checkout, the build output, and the running apps. Amp's self-hosted orb providers make this explicit. Amp sends a provider program `spawn`, `pause`, and `delete` jobs, and each job must be safe to repeat and finish within five minutes. ([Self-hosted orbs](https://ampcode.com/docs/orbs/self-hosted).)

Nexus keeps the same split:

- One pi-durable harness on the control plane runs every thread's agent loop. It holds the model credentials and commits every step to its storage.
- Each pylon is a machine that executes tools. A pylon can be lost or rebuilt without losing the conversation.

The split matters for two reasons. Credentials for model calls never enter a pylon. A thread also survives a pylon crash, because a tool call that was in flight is reported to the model as interrupted instead of rerun. That is pi-durable's documented behaviour for tools not marked `replay: "safe"`.

## A thread is one conversation and one pylon

A thread is one unit of work. It always has exactly one pi-durable conversation and exactly one pylon. Every thread belongs to a project, and a project is one git repository.

You use a thread in either of two ways, or both at once:

- **Autonomous.** You give the thread a prompt. The pi-durable agent works while you are away.
- **Hands-on.** You open sessions inside the pylon with Herdr: interactive Claude Code, interactive pi, or a plain shell. These sessions play the role of Amp's Terminal pane. The conversation stays empty if you never prompt the pi-durable agent.

A Claude Code session is a session inside a thread, not a separate kind of thread. A second thread kind would need its own code paths in the dashboard, the outputs, and the wake rules, and would save only one empty record.

## The parts

- **Nexus control plane.** One process on the main node, `rj-firebat`. It owns the API, the registry in SQLite, the event stream, and the dashboard. It stores the desired state of every thread and pylon.
- **The harness.** pi-durable, running inside or beside the control plane. It reaches a pylon through pi-env's Rust daemon inside the pylon, over a byte stream the probe carries. Spike S3 chose the daemon over a new adapter.
- **Probes.** One node agent per machine, today `rj-firebat` and `infra-testbench`. A probe runs pylon jobs, reports what it observes about its pylons and sessions, and carries terminal streams. The control plane opens every connection to it over HTTP and WebSockets on the home tailnet. The probe accepts a caller only if `tailscaled` names it as the expected node. The tailnet policy is unchanged, with no tags and no ACL edits.
- **Backends.** A probe never creates a VM itself. It drives an in-process backend interface. Amp's provider uses one dispatch program per job, but a pylon cannot dial out the way an orb does, so the probe also carries exec, terminals and services, and those do not fit one short program per job. The jobs keep Amp's `spawn`, `pause` and `delete` shape. The first backend is `pylon-vm`, a hard fork of pi-sandbox that drives Gondolin and QEMU. A Docker backend is a cheap test double. A Firecracker backend can come later without changing the control plane.
- **The pylon image.** A Debian root filesystem with Amp's conventions: a non-root `user` with passwordless sudo, the checkout at `/home/user/workspace/repo`, git, `gh`, Neovim, Node, Python 3, Herdr, Claude Code, and pi, with your Claude Code and pi setup baked in (see Configuration). Gondolin supplies its own kernel and takes the root filesystem from an OCI image. Spike S1 checks this.
- **Sessions.** Herdr runs inside every pylon. Nexus does not use tmux. Herdr reports pi status through its pi integration, and Claude Code hooks report Claude Code status.
- **Previews.** Each probe publishes a pylon's services with `tailscale serve`, so any device on the home tailnet opens them over HTTPS. Spike S4 checks this.

## Lifecycle follows Amp

- Starting a thread spawns a fresh pylon from the project's template on a node. `rj-firebat` is the default node.
- A pylon sleeps when its agents are idle and nobody has used it for a while. Amp uses 5 minutes of agent idleness and 20 minutes without a human. Nexus starts with the same numbers. A terminal attached to the pylon's Herdr session, such as `nexus attach`, counts as a human for as long as it stays attached, because the probe counts the guest's Herdr clients in every observation. Close the terminal to let the pylon pause.
- Sleep is a disk checkpoint. The VM stops and memory is lost.
- Waking boots the pylon from its checkpoint, restarts services, runs `.nexus/resume`, and relaunches every recorded Herdr session into its prompt. Claude Code runs `claude --resume <session id>` and finds its transcript on disk. The command that was running at sleep time shows as cut off.
- Archiving a thread puts its pylon to sleep at once. Deleting a thread deletes its pylon.
- A stopped pylon can move to another node by copying its disk. Disk checkpoints do not depend on the CPU, so moving between the Intel and the AMD node works. Spike S7 tested one round trip.

Pylons are owned by threads only. Named pylons that outlive a thread are deferred. The pylon record stores its thread, so adding them later changes one field and the delete rule.

## Network and credentials

- Gondolin blocks all outbound traffic except HTTP, TLS, and SSH to allowed hosts. Each project lists its allowed hosts.
- Model credentials for pi-durable threads stay on the control plane.
- Tool credentials, such as a GitHub token, stay on the node. Gondolin substitutes a placeholder in outbound HTTP headers for allowed hosts only. Git over SSH is terminated on the host, so the private key never enters a pylon. Git over HTTPS to github.com asks `gh` for credentials, and `gh` reads `GH_TOKEN` at that moment, so the placeholder, which changes on every boot, is never written to disk.
- Interactive Claude Code and Codex sessions need a `/login` inside the pylon for now. `nexus session open` opens a Claude Code session and `nexus attach` gives a Mac terminal on it. The project needs `logins: ["claude"]`, whose hosts (`src/project.ts`) cover Claude Code's own list of required hosts for a claude.ai login, including `platform.claude.com`, where OAuth tokens are refreshed. The optional hosts are left out: `sso.claude.com` for organizations with SSO, `mcp-proxy.anthropic.com` for claude.ai connectors, `raw.githubusercontent.com` for the changelog, and Datadog telemetry. Claude Code's Remote Control, which lets you steer from the phone, needs a claude.ai login and does not work with a long-lived setup token. Because pylons are thread-owned, every new thread that uses these tools needs a new login. A shared credential service is deferred.
- Templates never contain secrets.

## Configuration

- Each project has its own files under `.nexus/`. `.nexus/setup` runs once per template as `user` and has a 20-minute limit. `.nexus/resume` runs on every wake. `.nexus/services.yaml` declares supervised services and previews, with a schema that starts from pi-sandbox's. Nexus copies Amp's design, not Amp's file names.
- A template is keyed on the project, the image and a hash of the setup script, and is reused for at most 72 hours, as in Amp. Base images are built with Docker on `infra-testbench` and copied to the other node.
- Your Claude Code and pi setup reaches every pylon in three parts. The image bakes the capabilities this Mac runs: Claude Code plugins and the mods they carry, skills, and pi packages and extensions, minus those that are recursive inside a pylon or only work on the Mac. `node src/agent-setup.ts` on the Mac captures them into a pinned manifest in the image recipe, so a refresh is a capture and an image build, and the image ID changes with the setup. They are baked rather than installed at boot because pylons cannot reach npm or GitHub, and a wake has a 120-second hook limit. The common dotfiles layer holds rules and settings that are true anywhere, and the resume hook pulls it on every wake. The pylon layer tells the agent that it is in a pylon, which hosts it can reach, where previews appear, and how to declare outputs. The image imports it into Claude Code's and pi's instructions.

## Outputs

A thread produces a list of outputs, not one fixed kind. An output is a pushed branch, a diff, a live preview, or a file such as a screenshot. The probe records most outputs without help from the agent by reading `git status`, pushed branches, and running previews. The agent declares the rest.

## What Nexus reuses

These parts come from IgorWarzocha's `howaboua-pi-stuff`, which is MIT-licensed:

- `packages/pi-sandbox` is the base of `pylon-vm`, a hard fork copied into Nexus and trimmed. Nexus does not track upstream, and pi-sandbox stays the reference to compare designs against.
- `scripts/setup-repo-sandbox.mjs` is the model for copying uncommitted local work into a pylon.
- `packages/pi-shepherdr`:
	- `src/peer-inbox.ts` steers a pi session without touching its editor.
	- `src/launch.ts` starts a session in Herdr, waits until it is ready, and rolls back on failure.
	- `src/remote/shepherdr-session.mjs` reads a pi session file backwards to find the latest reply.
	- `src/monitor-events.ts` reports agent status from Herdr events.
- `herdr integration install pi` supplies pi status inside pylons.
- `packages/pi-notes-compaction` keeps long sessions inside their context window.

Nexus lives in its own repository at `personal/nexus` and has no remote yet.

## Decisions

| Date | Decision |
|---|---|
| 2026-10-22 | The probe, project config and template image contracts in `contracts/` are agreed |
| 2026-10-22 | Nexus copies Amp's design and uses no part of Amp's stack, including its file names and environment variables |
| 2026-10-22 | pi-sandbox becomes `pylon-vm`, a hard fork owned by Nexus. pi-sandbox stays the design reference |
| 2026-10-22 | No tailnet tags or ACL changes. Probes check the caller's stable node ID |
| 2026-10-22 | Base images build on `infra-testbench` |
| 2026-10-22 | Phone steering through Claude Code Remote Control is deferred. pi logged in with ChatGPT is the first interactive agent to prove inside a pylon |
| 2026-10-22 | One pi-durable harness on the control plane runs every thread |
| 2026-10-22 | Herdr runs sessions inside pylons. Nexus does not use tmux |
| 2026-10-22 | Pylons are owned by threads only. Named pylons are deferred |
| 2026-10-22 | A thread is one conversation and one pylon, and every thread belongs to a git project |
| 2026-10-22 | Pylons can run on any node. `rj-firebat` is the main node and `infra-testbench` is the second |
| 2026-10-21 | Each pylon gets its own Claude and OpenAI login for now |
| 2026-10-21 | Waking relaunches sessions into their prompt and does not continue them automatically |
| 2026-10-21 | Dotfiles for pi and Claude Code go into every pylon in two layers |

## Open questions

- Spikes S1 to S7 test the riskiest assumptions on the nodes. Details are in `spikes/RESULTS.md`:
	1. S1 checks whether a Debian image boots in Gondolin with Herdr and Claude Code running as `user`. Passed with a workaround: the build took 35 s and a cold boot took 3.9 s. As `user`, the image ran Python, Bash, Node 24.22.1, Claude Code 2.1.308, and a headless Herdr 0.9.5. Gondolin 0.13.0's OCI build aborts when it copies Alpine kernel modules, because `fs.cpSync` follows the absolute link `vmlinuz -> /boot/vmlinuz-virt` to the host's unreadable `/boot`. A `postBuild.copy` of the unchanged module tree avoids the crash. The fix is tied to the kernel version. `spikes/UPSTREAM-ISSUE-DRAFT.md` holds an unfiled upstream issue. Image builds need Docker access for the build user.
	2. S2 checks whether Claude Code reaches Anthropic through Gondolin's TLS interception. Passed for requests without a login: `curl` received HTTP 401 from Anthropic, and `claude -p` stopped at "Not logged in". A non-root user cannot read `/etc/gondolin/mitm/ca.crt` through its FUSE mount. The pylon image therefore sets `NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt`. `vm.enableSsh()` needs `openssh-server` in the image. Resume from the checkpoint took 5.4 s. A logged-in Claude Code and Remote Control are not yet tested. That test needs a manual `/login` on the stopped checkpoint `~/nexus-spikes/state/s2-debian.qcow2`.
	3. S5 checks whether interactive pi logged in with ChatGPT works inside a pylon. Passed: a model request succeeded through Gondolin. The login needs the device-code method or a pasted redirect URL, because the browser callback on port `1455` listens inside the guest. pi 1.4.0 needs `auth.openai.com`, `chatgpt.com`, and `api.openai.com` on the allowlist.
	4. S3 checks whether pi-durable can run a tool inside a Gondolin VM. Passed with a scripted model: cold boot took 3.9 s and the tool round trip took 63 ms. pi-durable's `ExecutionEnv` interface covers far more than `exec` plus file reads and writes, so the harness should use pi-env's Rust daemon inside the pylon rather than a new adapter. How the daemon connects through Gondolin is not yet tested.
	5. S4 checks whether `tailscale serve` publishes a preview from a node. Passed: HTTP/2 200 from the Mac in 0.4 s, and the guest received the `Tailscale-User-Login` and `Tailscale-User-Name` headers. The guest sees `x-forwarded-proto: http`, so the pylon sets `PUBLIC_URL` to the `https://` address. The first HTTPS request timed out after 15 s and the retry passed, so the probe must warm up a new preview before it reports the preview as ready.
	6. S6 checks whether one node serves many preview ports through one gateway. Passed: six ports worked at once, the gateway saw each port in `Host`, and 72 requests from the Mac had no timeouts. Details are in `spikes/S6.md`.
	7. S7 checks whether a checkpoint written on `infra-testbench` boots on `rj-firebat`. Passed: a fresh checkpoint went from Intel to AMD and back, and its files survived. Resume took 2.4 s on AMD and 3.9 s on Intel. A checkpoint also booted from a different path after `qemu-img rebase -u`, so the same path on every node is a convenience, not a requirement. Streaming the copy through the Mac broke twice, so copies must be verified before a boot. Details are in `spikes/S7.md`.
- A Gondolin 0.13.0 guest with 2 GiB of memory hangs at boot on `infra-testbench`, while 3 and 4 GiB boot in 4 to 7 s. The console suggests the initramfs is loaded over the ACPI tables, but that is not proven. The pylon-vm backend refuses pylons under 3 GiB until this is understood. Pylons are planned at 4 to 16 GiB, and the whole slice passes at 4, 8, 12 and 16 GiB, with the guest seeing at least 90% of its size. Under load, a 16 GiB pylon held 14 GiB of touched memory on `infra-testbench` without an out-of-memory kill, and host swap use grew from 209 to 378 MiB, so that node has room for one such pylon under full load. `src/pylon-vm-memory.check.ts` runs that check. Gondolin keeps a running pylon's disk writes in an overlay in the temporary directory, and on a tmpfs those writes cost host memory, so each controller gets a scratch directory under the state root.
- The contracts leave spikes and source checks open, listed in [the contracts rationale](contracts/rationale.md#open-questions-and-risks). Copying checkpoints reliably between nodes is the riskiest, because streamed copies broke in S7.
