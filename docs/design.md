# Nexus design

Nexus runs coding agents inside microVMs on your own Linux machines. Each microVM is called a pylon. Nexus is modelled on Amp Orbs: you start a thread, a fresh pylon boots with the repository and tools ready, and the agent keeps working after your laptop sleeps. You come back later to steer it, open previews of the running app, and collect what it produced.

Status: Nexus runs on both nodes. The control plane and a probe run on `rj-firebat`, and a second probe runs on `infra-testbench`. A thread starts from any client, its pylon boots from the current image, and the agent's answers stream to every client as it writes them. `nexus attach` gives a Mac terminal on the pylon's Herdr sessions, through the control plane. A port that something in the pylon listens on can be published as a preview on the tailnet, and unpublished again. [The CLI reference](cli.md) lists the ports that cannot. Archiving pauses the pylon, and unarchiving wakes it with its disk, services and sessions intact. A Claude Code session logged in inside a pylon resumes its conversation after an archive and a wake, which was proven by hand on `rj-firebat`. `src/control/thread-on-node.ts` checks a thread's lifecycle on a node with a scripted model. The record shapes live in [the data model reference](data-model.md). The probe, project config and template image contracts live in [contracts](contracts/rationale.md). The CLI is described in [the CLI reference](cli.md). Planned work is listed in [the roadmap](roadmap.md).

## Nexus copies Amp's split between the agent loop and the machine

Amp runs model inference and the agent loop on its own servers. The orb only executes tools and holds the checkout, the build output, and the running apps. Amp's self-hosted orb providers make this explicit. Amp sends a provider program `spawn`, `pause`, and `delete` jobs, and each job must be safe to repeat and finish within five minutes. ([Self-hosted orbs](https://ampcode.com/docs/orbs/self-hosted).)

Nexus keeps the same split:

- One pi-durable harness on the control plane runs every thread's agent loop. It holds the model credentials and commits every step to its storage.
- Each pylon is a machine that executes tools. A pylon can be lost or rebuilt without losing the conversation.

The split matters for two reasons. Credentials for model calls never enter a pylon. A thread also survives a pylon crash, because a tool call that was in flight is reported to the model as interrupted instead of rerun. That is pi-durable's documented behaviour for tools not marked `replay: "safe"`.

## A thread is one conversation and one pylon

A thread is one unit of work. It always has exactly one pi-durable conversation and exactly one pylon. Every thread belongs to a project, and a project is one git repository. A scratch project has no remote: each of its threads starts from an empty repository, made with `git init` on the project's branch, for work that does not exist yet. Pylons are ephemeral, so deleting a scratch thread deletes everything in it. Nexus keeps no copy, and the agent publishes what is worth keeping, typically to a new GitHub repository.

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
- **Sessions.** Sessions run in Herdr inside the pylon, which starts when the first session opens or a terminal attaches. Nexus does not use tmux. Herdr reports pi status through its pi integration, and Claude Code hooks report Claude Code status.
- **Previews.** Each probe publishes a pylon's previews with `tailscale serve`, so any device on the home tailnet opens them over HTTPS. A preview belongs to a declared service, or to a port something in the pylon listens on, which a person or the agent publishes and can unpublish. Gondolin's ingress reaches a pylon only through its 127.0.0.1, so each preview goes through a relay in the pylon that connects to the server on 127.0.0.1 or `::1`. A server bound only to `::1`, as Node servers that bind `localhost` are, is previewed like any other. Spike S4 checks this. The app gets plain HTTP from the probe's gateway, with the public `Host` and `X-Forwarded-Proto: https`. An app that ignores that header names its own scheme, so it redirects the browser to `http://`, which the preview's port does not answer, and links its assets and live-reload socket over `http://` and `ws://`, which the browser blocks as mixed content. The gateway therefore rewrites a `Location` that points at the preview's own `http://` address to `https://`. It also adds `Content-Security-Policy: upgrade-insecure-requests` to every response, as a policy of its own, so the browser fetches the rest over HTTPS and WSS. The browser upgrades a navigation to an `http://` address on the node's tailnet name too, whatever its port, so a preview's link to a plain-HTTP port on that name, such as the dashboard's HTTP listener, fails with a TLS error. No CSP setting upgrades a page's own subresources but not those navigations, and rewriting bodies to do it would be far more work, so previews accept that cost. The gateway sends no HSTS, because HSTS covers every port of the node's tailnet name, and the dashboard still serves plain HTTP there.
- **Clients.** You drive Nexus from four places, which show the same things: the `nexus` CLI on the Mac, the control plane's web dashboard, a Claude Code mod in the `claude-mods` repository, and the `pi-nexus` pi extension. The two extensions run the CLI and read its JSON, so the CLI is the contract they share. The control plane streams each thread's conversation to them over server-sent events as the harness commits it.

## Shared attention and dashboard notifications

The control plane owns attention and the shared seen marker, rather than each client keeping its own interpretation. List rows and detail expose failed, parked, unread reply, working or null, in that order. The registry persists reply-end and seen timestamps. Marking seen or unread is not human activity and never wakes a paused pylon; a dashboard visit remains the separate human-activity action described below. The dashboard marks seen while the conversation is visible and focused, at most once every three seconds. It sends a reply watermark captured before reading the rendered conversation, never a newer timestamp from attention polling. A streamed conversation is certified against a matching HTML snapshot without replacing the stream's patch structure; while disconnected, only a rendered HTML refresh advances the watermark. The API caps the mark at that watermark. Reply timestamps advance monotonically past seen markers, including when both events happen in the same millisecond.

The dashboard uses attention in the sidebar and home table. It silently baselines threads on first load, notifies immediately for a new failed or parked state, and delays a new reply by two seconds, cancelling if work restarts and scheduling again for the follow-up’s final reply identity even if attention never stopped being reply. A focused dashboard shows a toast with Open for another thread; an unfocused one uses a system notification only in a secure context with permission. Permission is requested only by clicking its control. On plain HTTP, background system notifications are unavailable; toasts, favicon and title counts still work. System notifications use the optional direct HTTPS listener on 7443; see the deployment guide for certificate provisioning. Each attention list read and seen update has a ten-second deadline, including its response body, so a stalled connection releases the poll lock and the next poll retries. The badge counts failed, parked and reply threads, including archived ones, and displays `9+` above nine.

Rows of open threads whose attention is working or null are dimmed in the sidebar and home table, so the eye goes to the threads that need a fix, a review or a reply: failed, parked, reply and waiting stay bright. Waiting ranks below working in the order, yet it is the one of the two that is blocked on the person. The open thread's row never dims, and a dimmed row comes back to full strength on hover or focus. A thread whose harness or session turn runs shows `working 1m 03s` in its row, its home-table and inspector Agent field and the run bar, counted from the registry's `workingSince`. The page ticks it every second from that one timestamp, so the clock makes no requests of its own. A turn that began before the registry recorded starts shows `working` without a clock.

A conversation folds each run of consecutive tool calls between two messages into one line that says what the calls did, such as "Ran 3 commands, changed 2 files", and opens to the individual calls. Calls are counted by what they do rather than which tool made them, after t3code's tool-group summaries: an edit and a write to the same file are one changed file. Commands, changes and subagents come first, then reads and searches, and past three phrases the rest are counted as other tools. A notice, such as an interrupted turn or a model error, stays visible between two folds. The harness conversation and a Claude worker's transcript fold the same way.

## Lifecycle follows Amp

- Starting a thread boots a fresh pylon from the current image, on the node the request names or else the project's default node. The pylon clones the repository and runs `.nexus/setup` itself. The backend can build templates, which would skip that setup, but starting a thread does not use them yet.
- A pylon sleeps when its agents are idle and nobody has used it for a while. Amp uses 5 minutes of agent idleness and 20 minutes without a human. Nexus starts with the same numbers. A terminal attached to the pylon's Herdr session, such as `nexus attach` through the control plane, counts as a human for as long as it stays attached, because the probe counts the guest's Herdr clients in every observation. Close the terminal to let the pylon pause.
- Sleep is a disk checkpoint. The VM stops and memory is lost.
- Waking boots the pylon from its checkpoint, runs `.nexus/resume`, restarts services, and relaunches every recorded Herdr session into its prompt. Claude Code runs `claude --resume <session id>` and finds its transcript on disk, or starts afresh under the same ID when the session was never prompted. The command that was running at sleep time shows as cut off.
- Archiving a thread puts its pylon to sleep at once. Deleting a thread deletes its pylon.
- A stopped pylon could move to another node by copying its disk. Disk checkpoints do not depend on the CPU, so moving between the Intel and the AMD node works. Spike S7 tested one round trip by hand. Nexus has no move job yet, so a pylon stays on the node it started on.

Pylons are owned by threads only. Named pylons that outlive a thread are deferred. The pylon record stores its thread, so adding them later changes one field and the delete rule.

## Network and credentials

- Gondolin blocks all outbound traffic except HTTP, TLS, and SSH to allowed hosts. Each project lists its allowed hosts.
- Model credentials for pi-durable threads stay on the control plane.
- Tool credentials, such as a GitHub token, stay on the node. Gondolin substitutes a placeholder in outbound HTTP headers for allowed hosts only. Git over SSH is terminated on the host, so the private key never enters a pylon. Git over HTTPS to github.com asks `gh` for credentials, and `gh` reads `GH_TOKEN` at that moment, so git never stores the placeholder, which changes on every boot.
- Git over SSH reaches only the remotes a pylon booted with, so a repository its agent creates is pushed over HTTPS. A project granted `GH_TOKEN` for `api.github.com` and `github.com` gives its agents `gh`, which creates repositories and hands git the token on each push. PYLON.md tells the agent this, and the configured git author. The optional control.json `gitIdentity: { name, email }` is the person’s identity, not a separate agent account. A project may override it. Every boot, including checkpoint wake, sets `user.name` and `user.email` globally for `user` after installing common dotfiles. With neither configured, git stays unchanged and agents are told to ask the human, not invent an identity.
- Interactive Claude Code and Codex sessions need a `/login` inside the pylon for now. `nexus session open` opens a Claude Code session and `nexus attach` gives a Mac terminal on it, through the control plane, so the Mac needs no ssh access to the node. The project needs `logins: ["claude"]`, whose hosts (`src/project.ts`) cover Claude Code's own list of required hosts for a claude.ai login, including `platform.claude.com`, where OAuth tokens are refreshed. The optional hosts are left out: `sso.claude.com` for organizations with SSO, `mcp-proxy.anthropic.com` for claude.ai connectors, `raw.githubusercontent.com` for the changelog, and Datadog telemetry. Claude Code's Remote Control, which lets you steer from the phone, needs a claude.ai login and does not work with a long-lived setup token. Because pylons are thread-owned, every new thread that uses these tools needs a new login. A shared credential service is deferred.
- Templates never contain secrets.

## Configuration

- Each project has its own files under `.nexus/`. `.nexus/setup` runs once, on a pylon's first boot, and has a 20-minute limit. `.nexus/resume` runs on every wake. `.nexus/services.yaml` declares supervised services and previews, with a schema that starts from pi-sandbox's. Services start on every spawn and wake, after setup, and after resume has finished or run for 10 seconds. A service added while the pylon runs is picked up within about 10 s of the node's next report, one with a preview once the control plane assigns its URL. Editing a running service needs `nexus service restart`. Nexus copies Amp's design, not Amp's file names.
- A template is keyed on the project, the image and a hash of the setup script, and is meant to be reused for at most 72 hours, as in Amp, once starting a thread uses templates. Base images are built with Docker on `infra-testbench` and copied to the other node.
- Your Claude Code and pi setup reaches every pylon in three parts. The image bakes the capabilities this Mac runs: Claude Code plugins and the mods they carry, skills, and pi packages and extensions, minus those that are recursive inside a pylon or only work on the Mac. `node src/agent-setup.ts` on the Mac captures them into a pinned manifest in the image recipe, so a refresh is a capture and an image build, and the image ID changes with the setup. They are baked rather than installed at boot because a pylon reaches only its project's allowed hosts, and a boot hook has a 120-second limit. The common dotfiles layer holds rules and settings that are true anywhere, and a boot hook pulls it on every boot, before setup or resume. The pylon layer tells the agent that it is in a pylon, which hosts it can reach, where previews appear, and how to declare outputs. The image imports it into Claude Code's and pi's instructions.

## Outputs

A thread produces a list of outputs, not one fixed kind. An output is a pushed branch, a diff, a live preview, or a file such as a screenshot. The control plane records most outputs without help from the agent, from what the probe observes: `git status`, pushed branches, and running previews. The agent declares the rest with `nexus output add`.

The probe reads Git facts through one guest exec in each running pylon's checkout, cached for one minute across snapshots and observer reconnects. A new boot or an observed non-running phase invalidates that cache. The helper reads HEAD, the current branch, tracked/staged/untracked dirt and local/remote-tracking refs; it never fetches, contacts a remote, refreshes the real index or wakes a paused pylon. Git's optional locks and filesystem monitor are disabled for the read. `GIT_NO_LAZY_FETCH=1` prevents partial clones from fetching missing objects; `GIT_ALLOW_PROTOCOL` is empty to refuse Git transports even on versions that do not support that flag. Missing objects make the facts unavailable rather than causing a fetch. Work is bounded by a 2.5-second helper deadline, a 3-second guest-exec timeout, 1000 refs, 256 KiB per Git reply and a 60 KiB observation. Each Git process runs in its own process group; cleanup kills the whole group, including clean filters and their children. Full `refs/heads/` names identify the current branch without tag-name ambiguity, and NUL-delimited ref fields preserve Unicode line separators. Dirty detection stops at the first status byte. An unavailable checkout, timeout, oversized or malformed reply reports `git: null`, not a partial or clean tree; failures are cached too and logged once until recovery. Other pylon facts remain observable. The probe bounds controller waits too: all fact readers for a pylon start in parallel, with three-second wall deadlines (five seconds for services), so a stalled controller cannot block the node's snapshots for its 180-second RPC timeout. A timed-out read stays registered until its underlying call settles; later snapshots return unavailable facts instead of piling up duplicate RPCs, and late replies cannot overwrite published facts or caches. Healthy pylons still publish their facts within the same bounded snapshot.

A local branch's `pushedAs` is its existing non-symbolic remote-tracking upstream if it has one. Otherwise a same-named remote-tracking ref counts: prefer `origin/<branch>`, then a unique match on another configured remote. Ambiguous non-origin matches and symbolic remote aliases do not count. Thus a `push.default=current` push or a push made around `gh pr create` needs no configured upstream. Commit equality alone never links differently named branches. The remote-tracking ref can lag local commits: this records a known published branch name, not that the current local tip is pushed. These local refs may also have come from a fetch or be stale after remote deletion; the probe does not claim it can prove who pushed them. Reconcile accumulates branch outputs from these names and diff outputs from dirty HEADs without retracting earlier outputs.

## Files and changes

A client sees what a thread did through two views, as in Amp: Files browses the pylon's checkout and opens any file in it, and Changes lists the files that differ and their diff. The control plane reads both from the running pylon on demand, through a raw pipe its probe carries, with one small Python helper (`src/checkout-files.py`) per read. Nothing is copied off the pylon in advance, so reading a paused pylon wakes it, as any other request a human makes does.

- Changes compare the working tree, untracked files included, with the commit the pylon booted at, so the agent's commits count too. Each pylon records that commit as `refs/nexus/base` in its checkout on its first boot. A scratch pylon boots an empty repository, which has no commit, so it records the empty tree, and every file the agent makes shows as added, committed or not. HEAD before the first commit is the empty tree too. Changes since HEAD show the uncommitted work alone. Latest turn compares with a snapshot before the autonomous reply starts, so pre-existing uncommitted work does not count.
- Before the first model request of each durable run, the harness snapshots through the checkout helper into `refs/nexus/turn`, a parentless commit built with a temporary index. Start rather than end snapshots isolate the reply from work between replies, and cover the first turn of an empty scratch repository. A turn is the whole reply, including tool rounds and steering; queued follow-ups start new ones. No snapshot asks for a wake. The first input submission identifies the whole reply; generation task IDs change after tool rounds and cannot identify it. The durable `nexus.turn-snapshot` conversation document records the attempted reply before capture, and an on-disk marker makes capture idempotent. Later tool rounds and recovery cannot replace the base after tools ran. Failure is logged and the reply continues; reads verify the snapshot's first input ID against the active reply or the last attempted reply in that document, refusing an old snapshot even after a transport failure. Interactive terminal sessions do not capture turns yet.
- The dashboard offers Latest turn beside Only uncommitted. Scope changes use the same read gate as the existing controls: no timer reads, and a paused pylon needs the person's wake confirmation.
- Only paths in the checkout are read, so a client never shows the pylon's Claude Code and pi logins, which live in its home directory. The reads run in the pylon, so this guards against mistakes, not against the pylon, whose agent can read those files anyway.
- A file is served under a content type that cannot run as a page of the API's origin, because the dashboard shares that origin.

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

Nexus lives in its own repository, `ramtinJ95/nexus` on GitHub.

## Release reconciliation and caller checks

The release planner in `src/deploy/plan.ts` has the same boundary as pylon reconciliation: desired and observed state in, a decision out. Root workers poll control directly, validate main ancestry in their own clone, and reconcile each installed role. The control plane goes first; probes require its fresh healthy desired-release report. Link and unit rollback is journaled locally so recovery does not depend on the API that may have failed.

Release setting is separate from ordinary caller admission: callers must also be in `deployers`, which defaults off. Every infrastructure node, including self, is excluded even if listed. Thus guest egress carrying a host's tailnet identity cannot deploy. The pylon bridge has no deploy operation and no general-purpose API forwarding. Root node polling additionally requires a per-node token whose digest is in control.json, and verifies control's tailnet identity before sending the token. See [deployment](../deploy/README.md) for provisioning and the trust limits of machine identity.

A persistent drain lease blocks API and background PR-watch turn entry, and counts in-flight admission before examining committed harness runs and queues. It refuses at timeout rather than interrupting an in-flight tool. The final idle fence seals the lease before the link switch so it cannot expire underneath interrupted-install recovery. A fixed root supervisor and bootstrap worker remain outside automatic link updates, so a bad candidate worker cannot stop a later release fixing it.

## Decisions

| Date | Decision |
|---|---|
| 2026-10-26 | [The merge policy](merge-policy.md), as the person approved it, says when an agent may merge and deploy a pull request without the person, and which changes always need the person |
| 2026-10-26 | The review loop runs on the control plane, started by `nexus review <thread>`, not for every PR yet. A Claude worker's PR is reviewed by a harness thread on the harness's OpenAI model, and a harness thread's PR by a Claude worker, so the reviewer is always another model family. Agents answer in fenced JSON blocks that echo a random token sent with each request, read from their replies. The control plane runs `.nexus/check` at the approved head itself, in a fresh agentless check thread it deletes afterwards, and takes the verdict from the exit status of the probe's pipe, never from a file the check could write. Only a harness reviewer's approval can land, since a Claude reviewer's verdict is read from a pylon where PR code could run. Landing checks the policy again before every merge attempt, merges only the approved head, deploys only Nexus's own PRs, verifies a rollback before claiming it, and needs a caller with the deploy right |
| 2026-10-26 | The preview gateway keeps the browser on HTTPS for apps that name their own scheme: it rewrites redirects to the preview's own `http://` address and sends `upgrade-insecure-requests`, which also breaks a preview's links to plain-HTTP ports on the same name. It does not rewrite bodies, and sends no HSTS, which would cover the dashboard's plain HTTP port on the same name |
| 2026-10-26 | A Claude worker's conversation is its session transcript, read from the pylon over the probe's raw pipe when session events say it changed and kept in the registry. Steering types the message into Claude's prompt in short pieces, never into the harness |
| 2026-10-26 | Dashboard terminates TLS directly on 7443 with tailscaled cert-only access and renewal; TCP-peer whois remains the only caller identity. No dashboard Serve entry: a Unix target would require local-admin rights for the probe’s later preview writes. HTTP starts independently of certificate availability; HTTPS retries failures and reports its state in health. HTTP clients stay unchanged |
| 2026-10-25 | A prompted Claude launch types its own bash-quoted command, because Herdr refuses multi-line agent arguments |
| 2026-10-25 | A Claude turn that ends with background subagents running stays working until the turn after its last subagent ends, judged by the Stop hook from Claude's own task list |
| 2026-10-25 | A retained cursor-based event stream is shared by every session; opt-in Claude Code workers run `/poteto-mode` inside pylons and report lifecycle through bounded, non-blocking hooks |
| 2026-10-23 | Root release reconciliation uses direct tailnet plus root-token polling, external-node-only deployers, control-first activation, a conservative drain barrier and a fixed recovery supervisor |
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
	2. S2 checks whether Claude Code reaches Anthropic through Gondolin's TLS interception. Passed for requests without a login: `curl` received HTTP 401 from Anthropic, and `claude -p` stopped at "Not logged in". A non-root user cannot read `/etc/gondolin/mitm/ca.crt` through its FUSE mount. The pylon image therefore sets `NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt`. `vm.enableSsh()` needs `openssh-server` in the image. Resume from the checkpoint took 5.4 s. A logged-in Claude Code was later proven in a pylon on `rj-firebat`: after a `/login` in a session that `nexus session open` opened, the session recalled its conversation after an archive and a wake. Remote Control is not tested.
	3. S5 checks whether interactive pi logged in with ChatGPT works inside a pylon. Passed: a model request succeeded through Gondolin. The login needs the device-code method or a pasted redirect URL, because the browser callback on port `1455` listens inside the guest. pi 1.4.0 needs `auth.openai.com`, `chatgpt.com`, and `api.openai.com` on the allowlist.
	4. S3 checks whether pi-durable can run a tool inside a Gondolin VM. Passed with a scripted model: cold boot took 3.9 s and the tool round trip took 63 ms. pi-durable's `ExecutionEnv` interface covers far more than `exec` plus file reads and writes, so the harness uses pi-env's Rust daemon inside the pylon rather than a new adapter. The daemon's frames reach the harness over a raw pipe that the probe carries (`src/harness/pylon-env.ts`).
	5. S4 checks whether `tailscale serve` publishes a preview from a node. Passed: HTTP/2 200 from the Mac in 0.4 s, and the guest received the `Tailscale-User-Login` and `Tailscale-User-Name` headers. The guest sees `x-forwarded-proto: http`, so the pylon sets `PUBLIC_URL` to the `https://` address. The first HTTPS request timed out after 15 s and the retry passed, so the probe must warm up a new preview before it reports the preview as ready.
	6. S6 checks whether one node serves many preview ports through one gateway. Passed: six ports worked at once, the gateway saw each port in `Host`, and 72 requests from the Mac had no timeouts. Details are in `spikes/S6.md`.
	7. S7 checks whether a checkpoint written on `infra-testbench` boots on `rj-firebat`. Passed: a fresh checkpoint went from Intel to AMD and back, and its files survived. Resume took 2.4 s on AMD and 3.9 s on Intel. A checkpoint also booted from a different path after `qemu-img rebase -u`, so the same path on every node is a convenience, not a requirement. Streaming the copy through the Mac broke twice, so copies must be verified before a boot. Details are in `spikes/S7.md`.
- A Gondolin 0.13.0 guest with 2 GiB of memory hangs at boot on `infra-testbench`, while 3 and 4 GiB boot in 4 to 7 s. The console suggests the initramfs is loaded over the ACPI tables, but that is not proven. The pylon-vm backend refuses pylons under 3 GiB until this is understood. Pylons are planned at 4 to 16 GiB, and the whole slice passes at 4, 8, 12 and 16 GiB, with the guest seeing at least 90% of its size. Under load, a 16 GiB pylon held 14 GiB of touched memory on `infra-testbench` without an out-of-memory kill, and host swap use grew from 209 to 378 MiB, so that node has room for one such pylon under full load. `src/pylon-vm-memory.check.ts` runs that check. Gondolin keeps a running pylon's disk writes in an overlay in the temporary directory, and on a tmpfs those writes cost host memory, so each controller gets a scratch directory under the state root.
- Where can a verify stack run, for the merge policy's live check? A live check boots the change as a small Nexus fleet, a control plane and a probe with pylons, and drives it as the verify-nexus skill does. A pylon cannot host that today: the image has no Docker and no `kmod`, so its guest has no `/dev/kvm` and no container runtime. Until a verify stack exists, every landing takes the policy's other branch, where the pull request says what could not be checked live. The options:
	1. **Nested virtualization in a pylon.** The pylon's own guest runs the stack with the pylon-vm backend, QEMU in QEMU. Checked on `rj-firebat` on 2026-10-26 (`docs/verification/review-flow/nested-kvm.txt`): the guest's CPU shows `svm`, the Gondolin kernel ships the `kvm`, `kvm-amd`, `irqbypass` and `overlay` modules, and once they were loaded by hand `/dev/kvm` appeared with nested paging and a real-mode guest ran on it. So the host already allows nested KVM, and only the image is missing `kmod` and a way to load them at boot. Whether `infra-testbench`'s Intel host allows nested VMX is unchecked. A nested pylon needs more memory than a normal one, at least the 3 GiB pylon-vm's floor per inner pylon plus the outer stack, and is slower.
	2. **A dedicated pylon kind for verification.** The same as the first option, but only a verify pylon gets the modules, a Docker daemon and the extra memory, so ordinary pylons keep today's smaller surface. It adds a pylon kind the planner and the dashboard must know, which the design has avoided for Claude workers.
	3. **A node-side job.** The probe runs the stack on the node itself, with Docker as `infra-testbench` already has for image builds. It is the fastest to build, but it runs the pull request's code on an infrastructure node outside any VM, with the host's tailnet identity and secrets in reach. That defeats the reason pylons exist.
	4. **Docker inside a pylon.** The guest kernel has the overlay, veth and bridge modules, so a Docker daemon could run in the pylon with the Docker backend, as the verify-nexus skill's stack does on a Mac. It needs `kmod`, `iptables` and Docker in the image, and Docker's own network inside Gondolin's is unproven. It cannot run pylon-vm's own backend, so it checks less than the first option.

	Recommendation: the first option, built as the second. A verify pylon is an ordinary pylon whose image or boot loads the KVM modules, so it reuses everything a pylon has (the egress allowlist, the checkpoint, the attach route), runs the real pylon-vm backend inside, and keeps PR code inside a VM. It starts with one more boot step and an image change, which is an image rebuild and so the person's to approve. The review loop would then start the verify stack in a fresh verify pylon after `.nexus/check` passes, as it starts a check thread, and record a live check result the policy reads in place of the pull request's statement.
- The contracts leave spikes and source checks open, listed in [the contracts rationale](contracts/rationale.md#open-questions-and-risks). Copying checkpoints reliably between nodes is the riskiest, because streamed copies broke in S7.

## Pull request watch

The control plane discovers open GitHub PRs for recorded `origin/` branch outputs on the project's repository (derived from the probe's checkout Git facts, including same-named remote-tracking refs when no upstream is set), and polls linked open PRs roughly every two minutes. Scratch projects and other remotes are not inferred from the checkout. Reads use the control plane's optional `github.tokenFile`, never a pylon, and therefore never wake one. Each GitHub resource has its own conditional request cache; threads share discovery and PR reads in each pass. Checks include check runs and legacy commit statuses; passing means all reported checks are complete and successful (neutral/skipped check runs are accepted), not just branch-protection-required checks.

A failed check, recovery after a reported failure, new submitted review or comment, or a conflict batches into one follow-up message per thread per pass. The first link baselines existing comments, but reports current failures and conflicts. pi-durable 1.4.0 supports application input entries: messages use `nexus.pr-watch`, sender metadata, and an explicit automated text prefix. They count only as agent activity, so the usual five-minute agent grace and twenty-minute human idle rule still apply. A Claude worker thread has no harness conversation, so the same message is typed into its Claude session through the steering path (`src/control/inbox.ts`), with CRLF line ends made newlines and tabs made spaces, as Claude's prompt needs. It too counts only as agent activity: it wakes a paused pylon and waits, kept pending, until the pylon runs and Claude is not at a dialog. Its request ID is fenced like a person's message, so a send that failed partway is never typed twice.

Only reviews, review comments and issue comments whose GitHub `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` are forwarded to the agent. The same rule applies to the PR author: being the author alone grants no trust. Missing or other associations are skipped before event tracking and never count toward the wake cap.

GitHub gives no reliable provenance distinguishing a person's comment from an agent's arbitrary `gh` or HTTP call with the same token. The watcher therefore does not filter by login, bot status, or activity timing. Such guesses would lose the person's reviews. Ten consecutive comment-only wake messages stop the thread's watch durably; any check or conflict wake resets that counter. An unarchive does not clear the cap. Existing comments are identified by their resource kind and ID; edits alone do not wake.

Merged and closed PRs retain their final state and last known check/review summary but are no longer polled. Rediscovering a closed PR as open reactivates its link without clearing consumed event IDs, reported failures or the comment-wake count; reopening does not bypass a reached cap. Archived and deleted threads do no discovery, polling or delivery. Unarchive resumes an uncapped watch with its old cursor, including feedback received while archived. A durable pending message and a stable harness request ID bridge the registry and harness databases: retry after a crash does not send the same news twice. Read or delivery errors appear on the detail and are retried, without exposing credentials or raw transport errors.

A GitHub 403 or 429 sets a shared rate-limit cooldown only when `x-ratelimit-remaining` is zero or `Retry-After` is present. The watcher honours `Retry-After` (seconds or an HTTP date) and an exhausted primary limit's reset time, waiting for both if supplied. Ordinary access denials, including repository-specific SAML restrictions, fail that watch without putting other repositories into cooldown.

## The review loop and landing

A task's review used to run on the person's Mac, through a Claude Code coordinator and its workers, so it stopped whenever that session did. The control plane runs it now, from the moment a builder thread's pull request is open until it lands or needs the person, under [the merge policy](merge-policy.md). `src/control/review.ts` holds the loop and `src/control/policy.ts` the policy's checks.

`nexus review <thread>` starts a review of the thread's open PR, the one the PR watch linked. It does not start for every PR on its own yet. The control plane starts a reviewer thread in the same project and node, on the PR's branch. Its model is another family than the builder's where one can run. A Claude worker builder gets a harness thread, which runs the harness's OpenAI model. A harness builder gets a Claude worker on Claude Opus 5.5, with no `/poteto-mode`, when the project grants a Claude token (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` for `api.anthropic.com`). Without one the review is refused, saying so, because a `/login` needs the person, and so does a ChatGPT login in a pylon, which is why a `chatgpt` login cannot serve a reviewer either. The PR watch skips reviewer threads, because a reviewer's checkout of the branch would link it to the PR it reviews.

Each round goes through the inbox that the PR watch also uses (`src/control/inbox.ts`), so a harness thread gets attributed `nexus.review` input entries and a Claude worker gets the text typed into its session through the steering path. Each request carries a fresh random token that only its recipient is told, which the answer must echo, so neither an earlier answer nor the other agent can answer it. The reviewer reviews the head against the base and ends its reply with a fenced `nexus-review` JSON block: approve or request changes, its findings, serious or minor, the reserved cases the change touches, and its quote of what the PR says could not be checked live. The builder gets the findings and ends its reply with a `nexus-review-answers` block that fixes or rejects each one with a reason. When it says it fixed something, the loop waits for the PR's head to move, then sends the reviewer the new commits and the answers for the next round. Commits pushed with answers that fixed nothing get a round too, since they are unreviewed. A clean approval runs `.nexus/check` at the approved head, and a failure goes back to the builder as a serious finding. The loop ends approved, after the rounds a review allows (three unless `--rounds` says otherwise, at most ten), or when an agent stays silent: a turn that ends without a readable block gets a reminder, at most two in a row, and three hours without an answer ends the review. Every message is saved in the review's record before it is sent, under a request ID made from the review and a count of its messages, so a pass after a crash sends it again under the same ID, which the harness and the Claude send both deduplicate. The time the first send began is saved before it too, and the wait for an answer counts from then, so an answer that came before a crash cleared the sent message is still read.

The check runs the pull request's own code, so no pylon whose contents decide a verdict ever runs it, and nothing it writes decides its own result (`src/control/gate.ts`). Each run starts a bare check thread, with no harness conversation and no Claude worker, whose pylon clones the repository at the approved commit. Once that pylon runs, the control plane opens one raw pipe into it, the probe's stream, whose process verifies the checkout's commit and then becomes `.nexus/check` with `exec`. The verdict is that process's exit status as the probe reports the stream's end, and the output's tail goes to the builder when it fails. The check thread is deleted after its verdict, so no process the check left behind reaches a later round. Only this control-plane process knows that it opened a run's pipe, so a check thread it holds no run for, as after a restart, or one whose pipe was lost, may have run something already: it is deleted, and the check starts again in a fresh one. A check thread no review holds, such as one started just before a crash, is deleted on the next pass. A Claude reviewer's verdict is still read from its transcript in its own pylon, where the reviewer itself may run the pull request's tests, so code from the change could forge one there. A Claude reviewer's findings still go round, and a review without a landing still ends approved, but its approval never lands: the policy holds a landing it approved for the person. A harness reviewer's verdict is the control plane's own agent loop's answer, out of the pylon's reach.

The record lives in the registry's `reviews` table, keyed by the builder. A pass runs every 15 seconds, and each phase reads the world again before it moves: the agents' replies, the PR, the release. A turn's replies are read only after a turn of that agent ended since its last message from the loop. A Claude worker's are its stored transcript, and a harness thread's come from one read of its conversation. A review that ends for the person makes the builder's attention `decision`, whose reasons `nexus show` and the dashboard list.

With `--land`, or `nexus land <thread>` after an approval, the loop lands the PR once its check passes. Landing deploys, so it needs the same right as `nexus deploy`, whatever the repository. Right before every merge attempt, including one retried after a restart, it runs all of the policy's checks again with what GitHub says then, and holds for the person with every condition that fails. Then it squash-merges with GitHub's head check, so only the approved commit can merge. A PR of Nexus's own repository, the one releases come from, then deploys: the loop records the release it replaces, sets the merge commit as the desired release, and waits up to 30 minutes for every component to report healthy, as `nexus deploy --wait` does. A failed, rolled-back or late deploy moves to rolling back: the previous release becomes desired again, and the loop waits up to 30 minutes more for every component to report it healthy before it tells the person it rolled back, and that the merge commit is still on the default branch. A rollback that fails too is reported as failed, with the components that failed. The control plane redeploying itself restarts the loop mid-landing, so the merge step saves the head it is about to merge before calling GitHub, and on a restart checks whether the PR merged already, and at the approved head. A merge at a head the review saved is its own. Any other merge, such as the person merging while the check ran, deploys only if every condition of the policy holds, the reserved paths and the reviewer's kind included, and otherwise ends in `decision`, and the deploy and rollback steps check whether their release is already desired, before acting. Once merging, a landing sees its deploy and any rollback through even if its threads are archived. A merged review never lands again.

Merging needs the control plane's GitHub token (`github.tokenFile`) to have write access to the repository's contents and pull requests. A read-only token, enough for the PR watch, makes a landing hold with GitHub's answer, and granting the wider token is the person's decision, as [deployment](../deploy/README.md) says.

## Editing project settings

Humans can use `nexus project edit <id>` or `PATCH /v1/projects/<id>` to change placement defaults, branch, resources, allowed hosts, logins, secret grants and git identity. IDs and repository URLs remain fixed. Add and edit share validation; secret hosts must be explicit, nonempty hostname lists. An edit changes only supplied fields; supplied lists replace whole lists, and a null identity removes the override. No agent-facing edit tool is provided. The dashboard's current limited creation dialog is unchanged.

Existing threads retain their placement, checkout, resources and network boot inputs. Running and paused pylons keep their original grants, and `show` exposes whether those differ from the project. The backend reconstructs network options on checkpoint wake, but reconciliation supplies the original saved boot network, not current project settings: archive/unarchive does not apply new grants. Start a new thread to use them, preserving the old thread's work first. Git identity alone is resolved again before a fresh boot or checkpoint wake, so a configured default reaches existing pylons too. Removing configuration does not erase an identity already on disk. Neither project edits nor identity configuration hot-update a running VM.

## Event stream and Claude Code thread workers

The control plane owns a retained, globally ordered event log, separate from the
conversation stream. Any authenticated session follows the same endpoint with a
cursor and thread/project/kind filters. A follower catches up from the registry
rather than subscribing to an in-memory-only broadcast, so disconnecting between
replay and live delivery cannot lose an accepted event. Retention expiry is an
explicit conflict, not a silent jump. Filtering and cursor validation live with
the event model in `src/events.ts`.

Claude workers run inside the pylon, not in the Nexus harness. Thread creation
persists a first prompt; reconciliation opens a Herdr Claude session when the
pylon runs. The initial argument preserves the prompt literally and avoids a
terminal-readiness/keystroke race. `/poteto-mode` is added unless already present.
Herdr 0.9.5's `agent start` refuses an argument holding a newline, tab or other
control character, so a multi-line prompt never reached Claude and the launch
stalled at the shell prompt. A prompted launch therefore types its own command
with `herdr pane run`, each argument a bash ANSI-C quoted word. Control
characters, `'` and `!` are escapes, so the typed line holds nothing the terminal,
readline or history expansion acts on, and Claude receives the exact text. A NUL
cannot be an argument, so the API refuses a prompt with one. Unprompted and
resumed sessions still use `agent start` and its readiness wait.
An uncertain launch is not retried automatically, since starting two coding
agents is worse than asking the person to inspect a possibly started session.
The sandbox justifies bypassed permission prompts, including on resume. Existing
secret injection supplies OAuth placeholders through login-shell environment.
Before every launch/resume, merge Claude's empirically observed onboarding and
trust state for the real checkout into its user files; retain credentials and
unrelated keys and file modes. Already-seeded files are not written. When a
write is needed, re-read before rename and re-merge changed content, up to five
attempts; fail rather than replacing a repeatedly changing file. Trust only the
pylon checkout, never a restored pane cwd, root or HOME. Theme and bypass acceptance live in settings.json on Claude
2.1.308, while onboarding and project trust live in .claude.json.
A worker is normally started after a launch-specific UserPromptSubmit hook writes a
local receipt. This avoids depending on best-effort network event delivery and
cannot confuse another session's event with the worker's first submission.
Herdr 0.9.5 offers only an interactive-readiness wait, not a submission wait,
and a prompted launch does not use it. Even when typing the command errors, allow
30 seconds for the receipt. A live Claude
process plus working status is fallback startup evidence. Never roll back an
uncertain first-prompt launch: retaining an empty pane is safer than killing work.
For unprompted launches, close only after confirming no Claude process runs. Missing proof leaves the
pane open and records stalled state, pane text, thread.failed and failed attention.
The launch fence still forbids automatic retries, including after interruption.
Persist its session ID before launch so a late turn-started report can clear
stalled attention without another session clearing it; retain the diagnostic
in the event history.

Claude hooks report lifecycle facts through the narrow host bridge. The probe
supplies identity, validates the event, journals a bounded reconnect buffer and
forwards it through observations. Control deduplicates those reports, updates
activity and attention, and appends the public event. Hook subprocesses are
independent of Claude and have short deadlines; local-probe outages can lose
reports rather than block the worker. Running session state is a 30-minute lease independent of
the retained log and of harness activity. Throttled PostToolUse heartbeats renew
it; a dead or silent worker cannot keep its pylon awake indefinitely. At most 16
session states per thread are kept, and ended or expired working rows are removed.
Waiting persists without refreshing activity. Hook timestamps and bounded durable
ordering cursors reject stale reports after an end; heartbeats renew existing
working leases or resume waiting sessions when newer than their waiting event. A waiting or ended turn returns to the normal
idle policy; seen remains unrelated to activity.

A main turn can end while background subagents keep working, as `/poteto-mode`
does when it delegates. Claude 2.1.308's Stop hook input lists them in
`background_tasks`, and Claude starts a new turn, with a `<task-notification>`
prompt, as each one finishes. So a Stop hook that lists a running subagent
reports a heartbeat, not a turn end. The session stays working, keeps its pylon
awake and gets no reply until the Stop of the turn that follows its last
subagent. Subagent tool hooks carry the main session ID, so their heartbeats
renew its lease. SubagentStart and SubagentStop are not used: Claude's own list
cannot miss a start, and SubagentStop also fires for internal helper agents that
never started one. Background shells do not count, because a dev server would
hold the session working until its lease ran out. A subagent that dies without a
finish leaves no follow-up turn, and the lease expires as for any silent turn.
Captures are in `docs/verification/claude-background-subagents/`.

Filtered stream reads use indexed registry columns, not decoding then filtering
every retained payload. Id-only keep-alives carry the scanned watermark past
skipped records. The CLI consumes those without printing them and waits for
stdout drain before reading more response data or advancing its cursor. Network
failure cannot start another reader around a pending output write.

### Claude launch policy (0.16.0)

Before every start/resume, merge `model: "claude-opus-5-5"` and
`attribution: { commit: "", pr: "" }` into Claude settings, retaining unrelated
keys, hooks and permissions. A per-thread model is passed explicitly with
`--model`, recorded in the registry, and saved from argv when checkpointing.
Claude 2.1.308 was verified with an actual local commit, a no-network `gh pr
create` shim and model usage responses; captures are in
`docs/verification/claude-worker-launch/`. This token can use Opus 5.5.

Submission evidence wins over a later launch RPC error. Only genuine unresolved
launches publish failure, using the same message stored on the worker. Matching
late submission reports recover failed as well as stalled launches. Neither
recovery nor restart resubmits a first prompt. Views render these registry facts
rather than interpreting historical failure events as current failure.

### Claude worker conversations and steering (0.17.0)

A Claude worker thread has no harness conversation, so its conversation is the
transcript Claude Code writes for the worker's session in the pylon. The control
plane reads it the way it reads the checkout for Files and Changes: one raw pipe
through the probe per read, with a small `sh` helper that prints the file's size and
the bytes after the stored offset. Unlike a checkout read, a transcript read is never
a human's request. It runs only while the node reports the pylon running, never
records activity, and a pylon the probe finds not running keeps what was stored. The
registry keeps the parsed entries, so a paused pylon, or a control plane that
restarted, shows the transcript as of its last read. Only complete lines are taken,
and a record over 512 KiB is skipped with a visible marker, so one huge tool output
cannot stall the reader.

The parser in `src/claude-transcript.ts` was written against real Claude Code 2.1.308
transcripts from a pylon. It turns them into a small model that only grows: prompts,
replies, tool calls, tool results paired by call ID, background task notifications
(subagents and shells), queue operations, notices and turn durations. Claude Code's
bookkeeping records are named in tables and left out. Any other record stays visible
as a generic entry, so a Claude Code upgrade that adds record types degrades to
showing them rather than hiding work. Subagents show as their `Agent` call, its
prompt, and the answer their notification carries. Their own transcripts under
`<session>/subagents/` are not read.

The session events decide when to read rather than a timer. The service follows the
retained event log, an indexed registry read once a second, and reads a Claude worker
thread after each `session.*` event for it. Heartbeats are throttled to one per five
minutes, so while a turn runs and a dashboard watches the thread, it is also read
every 2 seconds. That is what makes entries appear during a turn. The reads stop at
the turn's end, so an idle or unwatched thread costs nothing beyond its event reads.
The dashboard follows its thread stream as it does for a harness conversation, and
the conversation pane renders the entries with the same blocks.

Steering types the person's message into the worker's Claude session through the
probe command `send-claude`. Typing is the only input Claude Code's terminal takes,
and it behaves as the person at the terminal would expect. While Claude is busy, the
message joins Claude Code's own queue. Claude reads it at its next tool step within
the same turn (recorded as `absorbed_mid_turn`), or takes it after the turn. A
bracketed paste, or any long burst of input, is wrapped by Claude Code in
`<pasted_content>` tags. So the probe types the text in pieces of at most 64
characters, one Herdr `send-text` each, within one guest exec. It then waits half a
second and presses Enter, because Claude reads an Enter that directly follows a burst of
input as a newline. A newline types a line break without submitting, so multi-line
text arrives exactly.
Claude's prompt swallows a tab, and a carriage return submits early, so a message
holding them is refused rather than changed. The probe finds the session's pane by
Herdr's session ID or by Claude's command line. It resumes the session in place, or
in a new workspace, when no live Claude runs it, and it types nothing while Claude
waits at a dialog, because typing would answer that dialog. Right before typing, it
checks again that the pane runs Claude under the session's ID, and types nothing if
another agent or session took the pane meanwhile. The probe runs one send per session
at a time, from finding the pane to the Enter, so two sends never interleave their
pieces and never resume the session twice. Every outcome in which nothing was typed is
a result, not an error. A failed command may have typed part of
the message, so it is never retried automatically: the request ID is fenced as
sending first, and a repeat of an uncertain one is refused.

The API decides by the thread's Claude worker record before anything else, so no
mode or retry of a Claude worker thread's message reaches the harness. Sending is
human activity: it wakes a paused pylon, the wake relaunches the session before the
pylon counts as running, and clients retry the 409 until then with the same request
ID. Captures are in `docs/verification/claude-thread-streaming/`.
