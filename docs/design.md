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
- **Sessions.** Sessions run in Herdr inside the pylon, which starts when the first session opens or a terminal attaches. Nexus does not use tmux. Herdr reports pi status through its pi integration, and Claude Code hooks report Claude Code status. One table in `src/sessions.ts` holds what differs between the harnesses a session runs, `claude-code`, `pi` and `shell`: the dashboard label, Herdr's agent kind, the launch arguments, whether it takes a model or a first prompt, the state it seeds, whether a session runs in one pane only, and whether Herdr's working status is its agent activity. The probe's command schema, the API, the dashboard, the CLI's usage line and the registry's ingest all read it, so a new harness is one entry plus any launch code of its own.
- **Previews.** Each probe publishes a pylon's previews with `tailscale serve`, so any device on the home tailnet opens them over HTTPS. A preview belongs to a declared service, or to a port something in the pylon listens on, which a person or the agent publishes and can unpublish. Gondolin's ingress reaches a pylon only through its 127.0.0.1, so each preview goes through a relay in the pylon that connects to the server on 127.0.0.1 or `::1`. A server bound only to `::1`, as Node servers that bind `localhost` are, is previewed like any other. Spike S4 checks this. The app gets plain HTTP from the probe's gateway, with the public `Host` and `X-Forwarded-Proto: https`. An app that ignores that header names its own scheme, so it redirects the browser to `http://`, which the preview's port does not answer, and links its assets and live-reload socket over `http://` and `ws://`, which the browser blocks as mixed content. The gateway therefore rewrites a `Location` that points at the preview's own `http://` address to `https://`. It also adds `Content-Security-Policy: upgrade-insecure-requests` to every response, as a policy of its own, so the browser fetches the rest over HTTPS and WSS. The browser upgrades a navigation to an `http://` address on the node's tailnet name too, whatever its port, so a preview's link to a plain-HTTP port on that name, such as the dashboard's HTTP listener, fails with a TLS error. No CSP setting upgrades a page's own subresources but not those navigations, and rewriting bodies to do it would be far more work, so previews accept that cost. The gateway sends no HSTS, because HSTS covers every port of the node's tailnet name, and the dashboard still serves plain HTTP there.
- **Clients.** You drive Nexus from four places, which show the same things: the `nexus` CLI on the Mac, the control plane's web dashboard, a Claude Code mod in the `claude-mods` repository, and the `pi-nexus` pi extension. The two extensions run the CLI and read its JSON, so the CLI is the contract they share. The control plane streams each thread's conversation to them over server-sent events as the harness commits it.

## Shared attention and dashboard notifications

The control plane owns attention and the shared seen marker, rather than each client keeping its own interpretation. List rows and detail expose failed, decision, parked, limited, unread reply, working, waiting or null, in that order. The registry persists reply-end and seen timestamps. Marking seen or unread is not human activity and never wakes a paused pylon; a dashboard visit remains the separate human-activity action described below. The dashboard marks a reply seen once, when its conversation is visible and focused and shows that reply, so a reply another client marked unseen stays unseen until the page shows a newer one. It sends a reply watermark captured before reading the rendered conversation, never a newer timestamp from attention polling. A streamed conversation is certified against a matching HTML snapshot without replacing the stream's patch structure, or for a Claude worker, whose poll does not render the conversation while it streams, when the poll names the view the stream's last frame showed; while disconnected, only a rendered HTML refresh advances the watermark. A Claude worker's transcript is as of its last read, so its page sends no watermark until a read that started after the newest reply was recorded, and reached the transcript's end, is stored. The API caps the mark at that watermark. Reply timestamps advance monotonically past seen markers, including when both events happen in the same millisecond.

The dashboard uses attention in the sidebar and home table, which build each thread's line from its API row, once per page. It silently baselines threads on first load, notifies immediately for a new failed, decision, parked, limited or waiting state, and delays a new reply by two seconds, cancelling if work restarts and scheduling again for the follow-up’s final reply identity even if attention never stopped being reply. A focused dashboard shows a toast with Open for another thread; an unfocused one uses a system notification only in a secure context with permission. Permission is requested only by clicking its control. On plain HTTP, background system notifications are unavailable; toasts, favicon and title counts still work. System notifications use the optional direct HTTPS listener on 7443; see the deployment guide for certificate provisioning. One tab of the browser holds a Web Lock and follows `/v1/events?follow=true&since=latest` for the kinds that change a row's attention, reply or turn: `attention.changed`, `thread.turn-ended` and the session events but heartbeats. It reads `GET /v1/threads?deleted=false` each time the stream connects, once for each batch of those events, when a held-back reply comes due, every second while a turn runs over an unread reply, whose stop may send no event, a second after a read failed, and every ten seconds for what sends no event, such as a delete. It hands the rows to the other tabs over a BroadcastChannel, and a tab that loads or comes back into view asks it for them, so a hidden tab notifies and counts as fast as the stream's one-second tick without a request or a stream of its own. Every tab shows that one tab's reads in order, so none shows older rows over newer ones, and every tab holds a reply back to the same moment. When that tab closes, another takes the lock. A page over plain HTTP has no Web Locks, so each of its tabs reads the list every second. Each list read and seen update has a ten-second deadline, including its response body, so a stalled connection releases its lock and the next read retries. The badge counts failed, decision, parked, limited, reply and waiting threads, including archived ones, and displays `9+` above nine. A notification says the attention's label, such as "needs your decision" or "waiting for input".

Rows of open threads whose attention is working or null are dimmed in the sidebar and home table, so the eye goes to the threads that need a fix, a review or a reply: failed, decision, parked, limited, reply and waiting stay bright. Waiting ranks below working in the order, yet it is the one of the two that is blocked on the person. One table in `src/control/attention.ts` holds each attention's label, tone and whether it needs the person, and the rows, the badge and the notifications all read it, so a thread whose row stays bright is counted and notified. The open thread's row never dims, and a dimmed row comes back to full strength on hover or focus. A thread whose harness or session turn runs shows `working 1m 03s` in its row, its home-table and inspector Agent field and the run bar, counted from the registry's `workingSince`. The page ticks it every second from that one timestamp, so the clock makes no requests of its own. A turn that began before the registry recorded starts shows `working` without a clock.

A conversation folds each run of consecutive tool calls between two messages into one line that says what the calls did, such as "Ran 3 commands, changed 2 files", and opens to the individual calls. Calls are counted by what they do rather than which tool made them, after t3code's tool-group summaries: an edit and a write to the same file are one changed file. Commands, changes and subagents come first, then reads and searches, and past three phrases the rest are counted as other tools. A notice, such as an interrupted turn or a model error, stays visible between two folds. The harness conversation and a Claude worker's transcript fold the same way.

## Lifecycle follows Amp

- Starting a thread boots a fresh pylon from the current image, on the node the request names, on the node where it fits best when the request asks for `auto`, or else on the project's default node, which may itself be `auto`, as [Placement](#placement) describes. When the node holds a ready template of the project's setup at the thread's commit, the pylon copies the template's disk, checks out that commit and runs `.nexus/resume`, so `.nexus/setup` does not run. Otherwise it clones the repository and runs `.nexus/setup` itself, and the first such start of a setup on a node builds a template of it for later threads. `nexus show` says which path a thread took and why.
- A pylon sleeps when its agents are idle and nobody has used it for a while. Amp uses 5 minutes of agent idleness and 20 minutes without a human. Nexus starts with the same numbers. A terminal attached to the pylon's Herdr session, such as `nexus attach` through the control plane, counts as a human for as long as it stays attached, because the probe counts the guest's Herdr clients in every observation. Close the terminal to let the pylon pause.
- Sleep is a disk checkpoint. The VM stops and memory is lost.
- Waking boots the pylon from its checkpoint, runs `.nexus/resume`, restarts services, and relaunches every recorded Herdr session into its prompt. Claude Code runs `claude --resume <session id>` and finds its transcript on disk, or starts afresh under the same ID when the session was never prompted. The command that was running at sleep time shows as cut off.
- A Claude Code session runs in one pane, whatever the number of wakes. Herdr restores each workspace as a shell, because the image turns off its own agent resume, and the relaunch starts Claude in the restored pane. The probe runs a wake's relaunch, the launches and the sends of one Claude session one at a time, so a message that comes while the relaunch runs waits for it. A send that finds the session in no pane uses the restored pane the sessions file records for it before it opens a new workspace. A sessions file that names one Claude session in several panes, as wakes before this fix left behind, brings it back in the first and closes the others. Captures are in `docs/verification/one-claude-session/`.
- A session is `paused` only while its pylon is. The pylon's first running observation after a wake resumes its sessions in their panes with status `unknown`, before the probe has read them, so a read that fails or comes late never leaves a running Claude labelled paused. The probe logs a failed sessions read once, until one succeeds. Captures are in `docs/verification/session-state-after-wake/`.
- Archiving a thread puts its pylon to sleep at once. Deleting a thread deletes its pylon.
- A stopped pylon could move to another node by copying its disk. Disk checkpoints do not depend on the CPU, so moving between the Intel and the AMD node works. Spike S7 tested one round trip by hand. Nexus has no move job yet, so a pylon stays on the node it started on.

Pylons are owned by threads only. Named pylons that outlive a thread are deferred. The pylon record stores its thread, so adding them later changes one field and the delete rule.

## Placement

Each probe reports what its node has and what its pylons hold of it. A VM that is up holds its CPUs and memory, from the moment it launches until it stops. Every pylon holds its disk size until it is deleted. A paused pylon holds no memory, because its VM has stopped. Counting its memory would make a node with many paused pylons look full while it runs none of them. Committed CPUs and memory count every VM whose controller is alive, whatever runs in it: running and booting pylons, check and reviewer threads, and orphaned VMs the registry has not placed there. The probe also names the secrets in its node's secret file, without their values, the secrets it takes from the control plane, and whether the node has a git SSH key. `auto` counts a secret the probe takes as one the node has, even before the control plane has handed it over, so a start right after a restart is not refused. The pylon's boot waits for the handoff instead.

A thread starts on its project's default node unless the start names another node or asks for `auto`. A project's default node may itself be `auto`, and new projects default to it, because the person wants work spread out. A pinned default sent every thread to one node: about ten Claude worker threads committed 40 GiB on `rj-firebat`'s 22.8 GiB while `infra-testbench` sat idle. `auto` still refuses a node that cannot run the project's pylons, so a project needs a pinned node only when it must run on one machine. The cost is that when no node has room, a start fails instead of booting into an overcommitted node. Existing projects keep their default until a person edits it. With `auto`, the control plane weighs every node. A node can run the pylon when it is online, holds the current image, has every secret the project grants, and has a git SSH key if the repository or the dotfiles use SSH. The allowlist is the same on every node, so it never rules one out. Of the nodes that can run it, the pylon goes to the one with the most memory left once it boots there, then the most CPUs, then the most free disk. Memory and disk must fit, and a node whose committed memory already exceeds its memory is refused as overcommitted. CPUs may go below zero, because VMs share a node's CPUs and an idle pylon uses little of them. The room left counts pylons the planner is about to boot or wake on the node, which its last observation does not count yet: an unreported pylon holds all it asked for, and a paused one about to wake, or one whose controller died and a person retried, holds its CPUs and memory again. A broken VM that is still up is already counted in the node's capacity. A node whose last observation came from a probe too old to report grants is never chosen. When no node fits, the start fails with each node's reason and starts nothing. The thread records the placement, and `nexus show` prints it. The dashboard's start dialog offers `auto` beside the nodes.

A start may size its thread over its project's resources, field by field, so one heavy thread need not raise every thread's size. The size is frozen into the pylon's boot like its repository and grants, and placement weighs and reserves the thread's size, not the project's.

Every start reserves the room it placed its pylon in, whichever way the node was chosen, from the choice until the pylon's registry row exists or the start fails. A harness thread's conversation is created between the two, so without the reservation two overlapping `auto` starts would choose the same room. The registry holds the reservations in memory, shared by the API and the review loop. A crash ends the starts that held them, so losing the reservations loses nothing.

`nexus nodes` and the dashboard say which nodes are overcommitted, and sort each node's observed pylons into up, paused, archived, crashed and orphaned, so a person can see what a full node holds and what its paused pylons need to wake.

A scheduler that places work on its own still needs:

- The model tools' `start`, which an agent would use to start another thread, does not exist yet. A thread such a tool starts without a node would follow its project's default, which may be `auto`.
- A move job. A pylon stays on the node it booted on, so a node that fills up stays full until its threads are deleted. [The lifecycle](#lifecycle-follows-amp) describes how a move could copy a stopped pylon's disk, and spike S7 showed that copying checkpoints needs verifying.

## Network and credentials

- Gondolin blocks all outbound traffic except HTTP, TLS, and SSH to allowed hosts. Each project lists its allowed hosts.
- Model credentials for pi-durable threads stay on the control plane.
- Tool credentials, such as a GitHub token, stay on the node. Gondolin substitutes a placeholder in outbound HTTP headers for allowed hosts only. Git over SSH is terminated on the host, so the private key never enters a pylon. Git over HTTPS to github.com asks `gh` for credentials, and `gh` reads `GH_TOKEN` at that moment, so git never stores the placeholder, which changes on every boot.
- Git over SSH reaches only the remotes a pylon booted with, so a repository its agent creates is pushed over HTTPS. A project granted `GH_TOKEN` for `api.github.com` and `github.com` gives its agents `gh`, which creates repositories and hands git the token on each push. PYLON.md tells the agent this, and the configured git author. The optional control.json `gitIdentity: { name, email }` is the person’s identity, not a separate agent account. A project may override it. Every boot, including checkpoint wake, sets `user.name` and `user.email` globally for `user` after installing common dotfiles. With neither configured, git stays unchanged and agents are told to ask the human, not invent an identity.
- Interactive Claude Code and Codex sessions need a `/login` inside the pylon for now. `nexus session open` opens a Claude Code session and `nexus attach` gives a Mac terminal on it, through the control plane, so the Mac needs no ssh access to the node. The project needs `logins: ["claude"]`, whose hosts (`src/project.ts`) cover Claude Code's own list of required hosts for a claude.ai login, including `platform.claude.com`, where OAuth tokens are refreshed. The optional hosts are left out: `sso.claude.com` for organizations with SSO, `mcp-proxy.anthropic.com` for claude.ai connectors, `raw.githubusercontent.com` for the changelog, and Datadog telemetry. Claude Code's Remote Control, which lets you steer from the phone, needs a claude.ai login and does not work with a long-lived setup token. Because pylons are thread-owned, every new thread that uses these tools needs a new login. pi needs none in a project with the `chatgpt` login, as [pi's ChatGPT login in a pylon](#pis-chatgpt-login-in-a-pylon) describes.
- Templates never contain secrets.

### pi's ChatGPT login in a pylon

A project with the `chatgpt` login gives the pi in each new pylon a ChatGPT login, and nobody signs in. The control plane already holds one ChatGPT login, the harness's, and keeps it fresh. It hands the current access token to every node's probe, and Gondolin puts the token in place of a placeholder in requests to `api.openai.com`. The token never enters a pylon.

1. Every 60 seconds the control plane reads the harness's `openai` OAuth credential through pi-ai, which refreshes it first when less than 10 minutes remain. The refresh runs under the credential store's lock, so it never races the harness's own refresh of the same rotating refresh token. The control plane sends the access token to every probe with `PUT /v1/secrets/NEXUS_CHATGPT_TOKEN`, which only the control plane may call. It also sends it at once whenever a snapshot shows a probe that takes the token and has not got it, as after the probe or the control plane restarts. The refresh token never leaves the control plane. The control plane sends nothing while the harness signs in with an API key.
2. The probe keeps the token in memory and writes it nowhere. It hands it to the controller of every running pylon, which calls Gondolin's `secretManager.updateSecret`, and a pylon that boots takes the current token in its boot spec. Each handoff goes to every probe and pylon, changed or not, so a pylon that booted during a refresh has the current token within a minute. A probe that gets the token for the first time sends a snapshot at once, which lists it among the secrets it holds. The control plane sends a boot that needs the token only to a probe whose snapshot lists it there, so no pylon boots with a token its first request would be refused with. A probe from before the login looks for the token in its secret file instead and never lists it, so its boots wait for its upgrade. A missing secret fails a spawn for good, so a probe that restarted between that snapshot and the spawn boots the pylon with an unusable stand-in, which the next handoff replaces.
3. The `chatgpt` login grants `NEXUS_CHATGPT_TOKEN` for `api.openai.com` only. Like every grant, it is fixed when the thread starts. Every boot exports the grant's new placeholder to login shells, and a boot hook, after the dotfiles pull, writes it as the access token of the `openai` entry in `~/.pi/agent/auth.json` and keeps every other entry. That entry has an empty refresh token and expires in 2100, so pi never tries to refresh it, and could not.
4. pi's `openai` provider sends `Authorization: Bearer <placeholder>` to `api.openai.com/v1/responses` over HTTPS, with the reply streamed as server-sent events and no WebSocket. Gondolin swaps the placeholder there and refuses a request that carries it to any other host.

The design hands the token to pi's `openai` provider, not to `openai-codex`, because that is the client the token was issued to. The harness's login is pi-ai's Sign in with ChatGPT, which OpenAI issues for `resource=https://api.openai.com/v1`, and pi sends it to the Responses API there. The `openai-codex` provider is another OAuth client, the Codex CLI's. Its token goes to `chatgpt.com/backend-api/codex`, first over a WebSocket, with a `chatgpt-account-id` header that pi reads out of the token as a JWT. Gondolin's swap would cover that WebSocket, because it runs its request hooks on the upgrade request too. But the harness's token would need a JWT-shaped placeholder that carries the account ID, and would go to a backend OpenAI did not issue it for. Nexus cannot test that without spending the live login. Both providers offer `gpt-6-astra`, and the harness runs `openai/gpt-6-astra` on this token every day. The cost is that a model reference in a pylon must name `openai/<model>`. One that names `openai-codex/<model>`, such as a shepherdr profile captured from the Mac, stops with `No API key found for openai-codex`.

| Way | Token in the pylon | Sign-ins | Why not |
|---|---|---|---|
| Device-code login in each pylon | Yes, both tokens, in `~/.pi/agent/auth.json` | One per thread | The person rejects a sign-in per thread, and every agent in the pylon can copy the tokens |
| A relay through the probe at `http://nexus.pylon` | No | None | Every model stream would go through the probe's pylon API, which serves short JSON requests |
| A second control-plane login on the Codex client, with a JWT-shaped placeholder for `chatgpt.com` | No | One, kept apart from the harness's, because a refresh rotates the refresh token | It keeps `openai-codex` model references working, at the cost of a second login to hold and refresh |
| The harness's login, swapped for `api.openai.com` (built) | No | None | |

An agent in the pylon can spend the person's ChatGPT subscription through `api.openai.com`, as it can spend any granted secret, but it cannot read the token. `docs/verification/chatgpt-credential/` searched pi's environment and memory and the files under its HOME while a request ran, and found the placeholder and not the value. `api.openai.com` answers an invalid token with its first 8 and last 4 characters, never a valid one. Root on a node can read the current access token in the memory of the probe and of each pylon's controller, as it can read the node's `secrets.env`, and the token works for its remaining lifetime. The refresh token stays in the control plane's `harness-credentials.json`, as before. The Codex CLI and Claude Code in a pylon still need their own logins.

A Claude worker's shepherdr reviewer uses this login. The person's `reviewer` profile names `openai-codex/gpt-6-astra`, which is right on the Mac, where pi's `openai-codex` provider is signed in. In a pylon only the `openai` provider is, so the image's installer rewrites a captured profile's `openai-codex/` model to `openai/` and leaves the rest of the profile as captured. `docs/verification/in-thread-review/` records what `openai-codex` itself would need in a pylon.

## Configuration

- Each project has its own files under `.nexus/`. `.nexus/setup` runs once, on a pylon's first boot, and has a 20-minute limit. `.nexus/resume` runs on every wake. `.nexus/services.yaml` declares supervised services and previews, with a schema that starts from pi-sandbox's. Services start on every spawn and wake, after setup, and after resume has finished or run for 10 seconds. A service added while the pylon runs is picked up within about 10 s of the node's next report, one with a preview once the control plane assigns its URL. Editing a running service needs `nexus service restart`. Nexus copies Amp's design, not Amp's file names.
- A template is keyed on the project, the image and a hash of the setup script, `preSetup`, the allowlist and the project's disk size, since a pylon's disk size is fixed once it exists, and is reused for at most 72 hours, as in Amp. The control plane reads the setup script at the thread's commit from the project's remote when the thread starts, with a fetch of that one commit that skips file contents, into a repository of its own that it removes after, so concurrent starts share nothing. A template boot checks out exactly the commit that was read, so a branch that moves during the start cannot pair a pylon with a template of another setup script. Dependencies that setup installed can be up to 72 hours older than the commit's lockfile, and `.nexus/resume` runs after the checkout to refresh them where that matters. A template is reused only on the node that built it. A remote that needs SSH, which the control plane has no key for, always boots fresh. Base images are built with Docker on `infra-testbench`, by the probe there, when the person runs `nexus image build`. The control plane builds the image recipe of the release it runs. `nexus image rollout` copies an image to every other online node and makes it current only once every online node holds it, because `auto` placement passes over a node that lacks the current image. The image that was current stays on the nodes, and `nexus image rollback` makes it current again. A running or paused pylon keeps the image it booted from.
- Your Claude Code and pi setup reaches every pylon in three parts. The image bakes the capabilities this Mac runs: Claude Code plugins and the mods they carry, skills, pi packages and extensions, and pi-shepherdr's agent profiles, minus those that are recursive inside a pylon or only work on the Mac. `node src/agent-setup.ts` on the Mac captures them into a pinned manifest in the image recipe, so a refresh is a capture and an image build, and the image ID changes with the setup. They are baked rather than installed at boot because a pylon reaches only its project's allowed hosts, and a boot hook has a 120-second limit. The common dotfiles layer holds rules and settings that are true anywhere, and a boot hook pulls it on every boot, before setup or resume. The pylon layer tells the agent that it is in a pylon, which hosts it can reach, where previews appear, and how to declare outputs. The image imports it into Claude Code's and pi's instructions. It also tells Claude Code to have a shepherdr reviewer check its diff before it opens or updates a pull request, and to report which findings it accepted or rejected and why, as the person's own Claude Code instructions say on the Mac. Those instructions stay on the Mac. They mix rules for any machine with rules for the Mac's two tailnets, its home SOCKS proxy and `ts-home`, sometimes in one bullet, so importing them would bring Mac-only rules into a pylon, and filtering them would depend on how the person words each bullet. The pylon layer restates the one rule a pylon needs, and Nexus writes it, so it can also say whether the project's login lets the reviewer run.

## Outputs

A thread produces a list of outputs, not one fixed kind. An output is a pushed branch, a diff, a live preview, or a file such as a screenshot. The control plane records most outputs without help from the agent, from what the probe observes: `git status`, pushed branches, and running previews. The agent declares the rest with `nexus output add`.

The probe reads Git facts through one guest exec in each running pylon's checkout, cached for one minute across snapshots and observer reconnects. A new boot or an observed non-running phase invalidates that cache. The helper reads HEAD, the current branch, tracked/staged/untracked dirt and local/remote-tracking refs; it never fetches, contacts a remote, refreshes the real index or wakes a paused pylon. Git's optional locks and filesystem monitor are disabled for the read. `GIT_NO_LAZY_FETCH=1` prevents partial clones from fetching missing objects; `GIT_ALLOW_PROTOCOL` is empty to refuse Git transports even on versions that do not support that flag. Missing objects make the facts unavailable rather than causing a fetch. Work is bounded by a 2.5-second helper deadline, a 3-second guest-exec timeout, 1000 refs, 256 KiB per Git reply and a 60 KiB observation. Each Git process runs in its own process group; cleanup kills the whole group, including clean filters and their children. Full `refs/heads/` names identify the current branch without tag-name ambiguity, and NUL-delimited ref fields preserve Unicode line separators. Dirty detection stops at the first status byte. An unavailable checkout, timeout, oversized or malformed reply reports `git: null`, not a partial or clean tree; failures are cached too and logged once until recovery. Other pylon facts remain observable. The probe bounds controller waits too: all fact readers for a pylon start in parallel, with three-second wall deadlines (five seconds for services), so a stalled controller cannot block the node's snapshots for its 180-second RPC timeout. A timed-out read stays registered until its underlying call settles; later snapshots return unavailable facts instead of piling up duplicate RPCs, and late replies cannot overwrite published facts or caches. Healthy pylons still publish their facts within the same bounded snapshot.

A local branch's `pushedAs` is its existing non-symbolic remote-tracking upstream if it has one. Otherwise a same-named remote-tracking ref counts: prefer `origin/<branch>`, then a unique match on another configured remote. Ambiguous non-origin matches and symbolic remote aliases do not count. Thus a `push.default=current` push or a push made around `gh pr create` needs no configured upstream. Commit equality alone never links differently named branches. The remote-tracking ref can lag local commits: this records a known published branch name, not that the current local tip is pushed. These local refs may also have come from a fetch or be stale after remote deletion; the probe does not claim it can prove who pushed them. Reconcile accumulates branch outputs from these names and diff outputs from dirty HEADs without retracting earlier outputs.

## Files and changes

A client sees what a thread did through two views, as in Amp: Files browses the pylon's checkout and opens any file in it, and Changes lists the files that differ and their diff. The control plane reads both from the running pylon on demand, through a raw pipe its probe carries, with one small Python helper (`src/checkout-files.py`) per read. Nothing is copied off the pylon in advance, so reading a paused pylon wakes it, as any other request a human makes does.

- Changes compare the working tree, untracked files included, with the commit the pylon booted at, so the agent's commits count too. Each pylon records that commit as `refs/nexus/base` in its checkout on its first boot. A scratch pylon boots an empty repository, which has no commit, so it records the empty tree, and every file the agent makes shows as added, committed or not. HEAD before the first commit is the empty tree too. Changes since HEAD show the uncommitted work alone. Latest turn compares with a snapshot before the autonomous reply starts, so pre-existing uncommitted work does not count.
- Before the first model request of each durable run, the harness snapshots through the checkout helper into `refs/nexus/turn`, a parentless commit built with a temporary index. Start rather than end snapshots isolate the reply from work between replies, and cover the first turn of an empty scratch repository. A turn is the whole reply, including tool rounds and steering; queued follow-ups start new ones. No snapshot asks for a wake. The first input submission identifies the whole reply; generation task IDs change after tool rounds and cannot identify it. The durable `nexus.turn-snapshot` conversation document records the attempted reply before capture, and an on-disk marker makes capture idempotent. Later tool rounds and recovery cannot replace the base after tools ran. Failure is logged and the reply continues; reads verify the snapshot's first input ID against the active reply or the last attempted reply in that document, refusing an old snapshot even after a transport failure. Interactive pi sessions do not capture turns.
- A Claude Code turn is each prompt Claude receives. Its `UserPromptSubmit` hook in the pylon snapshots the same way, through the image's copy of the checkout helper, and names the snapshot `claude:<session>:<at>`, with the session ID and the millisecond stamp it also sends as `session.turn-started`'s `at`. The hook rather than the control plane takes it because Claude does nothing until its hooks return, while the event reaches the control plane after Claude may have started editing. The hook waits for the snapshot but kills its whole process group if it has not captured its commit within 1.5 seconds, below Claude's 2-second hook limit, so a slow snapshot neither holds the prompt nor captures Claude's first edits, and removes its temporary index either way. Once captured, the short ref update is let finish, because one killed midway leaves a ref lock that fails every later snapshot; claiming a turn writes only `.git/nexus-turn`, which reads also check, so it needs no ref update. Sessions can snapshot at once: under a lock, an attempt claims the marker only if the marker names no later Claude turn by start stamp, and publishes only if it still holds the marker, so an older turn never replaces a newer one's snapshot. A Claude worker thread's reads expect the ID of the newest turn start the registry recorded for the thread, from any session, so a failed snapshot, a lost or rejected event, or an image that predates the hook's snapshot refuses rather than showing an older turn. Every Claude Code session in the pylon snapshots, an interactive one included, and the checkout holds one snapshot, so an interactive Claude Code turn in a harness thread's pylon leaves that thread's latest turn unavailable until its next reply.
- The dashboard shows a file's diff highlighted for its language by `@pierre/diffs`, unified or split as the reader picks. The library's own component writes markup with inline styles, which the dashboard's content security policy blocks, so the dashboard draws the library's render as DOM in a shadow root and leaves the policy as it was. The library and each language's grammar are chunks of the bundled client, fetched when a diff, and then a file of that language, first opens.
- The reader can write review notes on a diff: a comment, a question, a suggestion or a requested change, on rows selected by their line numbers or with the keyboard. A note keeps the line numbers of its first and last rows and a quote of its rows. The new side's numbers are the working tree's on every base, so a note shows again under its last row on any base while its rows still read as quoted. A note whose rows changed is listed above that file's diff with its quote. The library's annotation rows hold the notes, and the page fills them through slots of the shadow root, so notes keep the dashboard's styles and the content security policy stays as it was. Notes stay in the browser's local storage, per thread, until they are sent or discarded. **Add to message** puts the review in the composer as one message, with each note's file, lines and quote, for the reader to edit. Sending it is an ordinary message, so it reaches a Claude worker or the Nexus agent as the composer's other messages do, and it clears each note whose entry it still holds. A note edited after the send began stays, and so do notes that share an entry's header line when the message holds fewer of those entries than there are notes, since the page cannot tell which one was cut. Tabs in the review become spaces, because a Claude worker refuses a message with a tab.
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

Release setting is separate from ordinary caller admission: callers must also be in `deployers`, which defaults off. Every infrastructure node, including self, is excluded even if listed. Thus guest egress carrying a host's tailnet identity cannot deploy. The same exclusion, without the `deployers` list, decides who is a person: an allowed caller that is neither the control node nor any node. Answering a question takes a person, and a question whose answer may deploy also takes a deployer. The pylon bridge has no deploy operation and no general-purpose API forwarding. Root node polling additionally requires a per-node token whose digest is in control.json, and verifies control's tailnet identity before sending the token. See [deployment](../deploy/README.md) for provisioning and the trust limits of machine identity.

A persistent drain lease blocks API and background PR-watch turn entry, and counts in-flight admission before examining committed harness runs and queues. It refuses at timeout rather than interrupting an in-flight tool. The final idle fence seals the lease before the link switch so it cannot expire underneath interrupted-install recovery. A fixed root supervisor and bootstrap worker remain outside automatic link updates, so a bad candidate worker cannot stop a later release fixing it.

## Decisions

| Date | Decision |
|---|---|
| 2026-10-28 | One table in `src/sessions.ts` is the registry of session harnesses. The harness names, the schemas that check them, the open-session fields each takes, the dashboard labels, the CLI's usage line and Herdr's working status as activity are derived from it, not written out per file. The pylon image's agent-setup manifest keeps its own `claude` and `pi`, because the image runs it without importing anything else |
| 2026-10-27 | Pressing Land on the dashboard waives the holds the merge policy reserves for the person: the reserved cases, the reserved paths and a change to `.nexus/check`. It never waives a Claude reviewer's approval, an open or unanswered finding, a failed check, failing GitHub checks, a moved head, a conflict or a closed pull request. `nexus land` sends no waiver, so an agent that drives the CLI does not waive by accident. It is not a security boundary: an agent on the person's Mac calls the control plane as the same tailnet node, so it could post the same request. The caller must still be a deployer |
| 2026-10-27 | A thread can be queued to start once other threads' pull requests merge. A queued thread is a record in its own table, keyed by the ID the thread gets, and not a thread row, so the planner, the PR watch, the review loop and placement never see it and hold no room for it. It starts through the normal start with that ID, and the transaction that inserts the thread's row marks the record started, so it starts once. What blocks it is derived from the predecessors on every read rather than stored, so a reopened or later-merged pull request unblocks it |
| 2026-10-27 | Attention is computed once, by the registry, from its own stored inputs, and the API reports the stored value, so the dashboard, the CLI and `attention.changed` always agree. The registry's parked flag, which the harness reports, is the parked input rather than the harness's live list, and a delete clears it. A waiting session needs the person in the badge and notifications as it does in the row |
| 2026-10-27 | No build leaves a session on a disk that pylons boot from. The image build installs the agent setup without starting pi, whose `claude-delegation` provider starts a Claude session, and pi's load check runs only in the smoke boot, whose disk is thrown away. The smoke boot refuses an image whose home has `~/.nexus`, Claude projects or session environments, or pi sessions. The hook reports only in a pylon with the overlay's `pylon.json`, which a template build has not. Before this, every pylon booted within a day of an image build sent the build's turn start and session end to its new thread |
| 2026-10-26 | A review whose pull request is closed, or merged outside a review that does not land it, ends `closed` or `merged`, and one whose builder or reviewer thread the person archived or deleted ends `cancelled`. Neither asks for the person, adds the label or runs another step. The loop trusts the PR watch's state between steps, which may be two minutes old, and asks GitHub itself only before it acts or ends the review, so a merge it has not seen yet costs a few reads, not a check or a decision. `needs-person` stays for failures the person did not cause |
| 2026-10-26 | New projects default to `auto`, and a project's default node may be `auto`. Existing projects keep theirs. Every start reserves its pylon's room in memory until the pylon's row exists. `auto` refuses an overcommitted node |
| 2026-10-26 | A running pylon's guest treats its disk as having no volatile write cache, so it sends QEMU no flushes and an fsync in the pylon waits on no fdatasync on the node. QEMU runs Gondolin's drive in its default writeback mode, which turns every guest flush into an fdatasync of the overlay in the node's temporary directory. In a pylon on `infra-testbench` that took 24 ms a synced write, and builders saw 120 ms on both nodes, so the SQLite tests took minutes and `.nexus/check` took 1302 s against 201 s without flushes (`docs/verification/pylon-disk-sync-writes/`). Those flushes made nothing durable: a boot resumes the last checkpoint and never the overlay a running VM wrote to, so a crash of the node, QEMU or the guest loses the work since the last pause either way. A stop turns the cache back on before its `sync`, which flushes, so a checkpoint is written as before. QEMU's own `cache=unsafe` would say the same at the drive, but Gondolin 0.13 takes no drive options |
| 2026-10-26 | A review runs at most five rounds, so a reviewer cannot ask for tweaks forever. A review whose rounds run out ends for the person with the pull request labelled `needs human review`, and a token that cannot label only adds a reason, so labelling never holds or retries the review. Findings carry priorities P0 to P3, and only P0 to P2 block, so P3 findings reach the builder as notes and never hold the loop or a merge |
| 2026-10-26 | A Claude worker reviews its own diff before a pull request with a shepherdr reviewer in its pylon, as the person does on the Mac. The image ships the shepherdr mod, pi-shepherdr and the person's pi-shepherdr profiles. PYLON.md carries the rule, not the person's global Claude Code instructions, which mix in Mac-only rules. The reviewer runs on pi's `openai` provider with the harness's ChatGPT login, so the installer rewrites a captured profile's `openai-codex/` model to `openai/` |
| 2026-10-26 | A start that needs the ChatGPT token is placed on a node whose probe takes it, even before the probe has it, and the planner holds the boot until it does. The control plane hands the token over as soon as a probe without it shows up. Refusing such a start at placement refused every one for about two minutes after each deploy, while the probes waited for the minute timer |
| 2026-10-26 | A project with the `chatgpt` login gives each new pylon's pi the harness's ChatGPT login. The control plane refreshes it and hands the access token to every probe each minute, the probe updates every running pylon's Gondolin secret, and a boot hook writes the grant's placeholder into pi's `auth.json` as the `openai` provider's token, with no refresh token. The token is the one OpenAI issued for `api.openai.com`, so the swap goes there and not to `chatgpt.com`, and model references in a pylon name `openai/<model>` |
| 2026-10-26 | A thread boots from a template only when its node holds a ready one of the setup at its commit, and then checks out exactly the commit the control plane read. The first start of a setup on a node boots fresh and builds the template in the background rather than waiting for it. The control plane reads `.nexus/setup` from the remote with a one-commit fetch into a repository of its own per start, not a shared mirror, so concurrent starts share nothing |
| 2026-10-26 | The control plane builds and rolls out the pylon image itself, as an operation it stores and advances, so a restart resumes it. `nexus image build` sends `build-image` with the recipe of the release the control plane runs, to the probe on `imageBuildNode`, and records the manifest it reads back. `nexus image rollout` sends checksum-verified `fetch-artifact` to every online node that lacks the image, and makes it current only once all of them hold it. A node offline at the start is skipped and fetches on first use. Rollback is a rollout of the image that was current before. Only `deployers` may run them, and under the merge policy only the person does. Build and rollout stay two commands, because a build changes nothing pylons use and a rollout is the decision |
| 2026-10-26 | A Claude worker that stops on its usage limit gets its own attention, `limited`, rather than `waiting` with a message: it outranks the reply its turn end records, seen does not clear it, and the transcript's error record, with the reset time Claude Code gives, is the evidence. The control plane types a continue after the reset only when its config opts in, once per stop and never into an archived thread, and three minutes after the reset, after Claude Code's own continue |
| 2026-10-26 | Hooks in a pylon write session events to a bounded outbox on the pylon's disk and return, and one sender at a time delivers it to the probe in order, deleting an event only once the probe has journaled it. A full outbox drops its oldest event, and an event a day old is dropped unsent. Each event carries an ID the hook gave it, and control ignores a report that repeats an ID it applied at its session's latest stamp. The sender also starts at every boot, and holds an event until hooks stamped earlier have had their two seconds, so delivery follows the stamps. The probe's journal is kept, because it covers the other hop, a control plane that is not following the probe |
| 2026-10-26 | A node's committed capacity counts the CPUs and memory of VMs that are up and the disk of every pylon, paused or not. `start --node auto` is opt-in. It ranks nodes by memory left after the pylon, then CPUs, then disk, refuses a node where memory or disk does not fit, and lets CPUs be oversubscribed |
| 2026-10-26 | A Claude turn that ends with only background commands running stays working while their process groups live, for up to 2 hours, until the turn their finish starts. One still running after 2 hours ends the turn and leaves the session waiting with a message that says so. Only Claude's permission and input prompts count as waiting, filtered by the image's hook matcher, not by the control plane. A Claude started inside another Claude session, or under another HOME, does not report into the thread |
| 2026-10-26 | [The merge policy](merge-policy.md), as the person approved it, says when an agent may merge and deploy a pull request without the person, and which changes always need the person |
| 2026-10-26 | `.nexus/check` runs in the image's environment, read from the check pylon's PID 1 rather than from profile files that `.nexus/setup` could rewrite. A check the pylon cannot run, a failed check the builder answers without a push, and a check that fails again at the same head go to the person without another round, and a repeat approval of an unchanged head costs no round. The pylon image's Node stays 24.22.1 below the project's `>=26` until the person approves an image rebuild |
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

Merged and closed PRs retain their final state and last known check/review summary but are no longer polled. Rediscovering a closed PR as open reactivates its link without clearing consumed event IDs, reported failures or the comment-wake count; reopening does not bypass a reached cap. Archived and deleted threads do no discovery, polling or delivery, except that for a thread a queued thread waits for, each pass first reads its unmerged linked pull requests and searches its branches for pull requests in any state, and saves every one's current state in one write once all are read, whatever its status, cap or undelivered message, so the queued thread sees the merge. Unarchive resumes an uncapped watch with its old cursor, including feedback received while archived. A durable pending message and a stable harness request ID bridge the registry and harness databases: retry after a crash does not send the same news twice. Read or delivery errors appear on the detail and are retried, without exposing credentials or raw transport errors.

A GitHub 403 or 429 sets a shared rate-limit cooldown only when `x-ratelimit-remaining` is zero or `Retry-After` is present. The watcher honours `Retry-After` (seconds or an HTTP date) and an exhausted primary limit's reset time, waiting for both if supplied. Ordinary access denials, including repository-specific SAML restrictions, fail that watch without putting other repositories into cooldown.

## The review loop and landing

A task's review used to run on the person's Mac, through a Claude Code coordinator and its workers, so it stopped whenever that session did. The control plane runs it now, from the moment a builder thread's pull request is open until it lands or needs the person, under [the merge policy](merge-policy.md). `src/control/review.ts` holds the loop and `src/control/policy.ts` the policy's checks.

`nexus review <thread>` starts a review of the thread's open PR, the one the PR watch linked. A project can ask for it to start on its own, with `nexus project edit <id> --auto-review review`, or `land` to land each approved PR too, as `nexus review --land` would. Only a person sets it, through the human-only project edit, and the project records the caller who did. Landing deploys, so `land` needs that caller among the control plane's `deployers`, and each landing checks again before every merge that the project still asks for it and that its caller still is one. When the PR watch first links an open PR to a thread of such a project, it tells the loop before it saves the link, so a call that failed is made again on the next pass, and the loop starts the review. It never starts one for a reviewer thread or a check thread, nor a second one for the same PR: a review that ended stays ended until the person runs `nexus review`. A PR the watch linked before the project opted in is not reviewed on its own. A review that cannot start, such as for a harness builder whose project grants no Claude token, or while the builder's review of another PR runs, is logged and not tried again. A builder still in its turn gets the findings once the turn ends, as for any review. The control plane starts a reviewer thread in the same project and node, on the PR's branch. Its model is another family than the builder's where one can run. A Claude worker builder gets a harness thread, which runs the harness's OpenAI model. A harness builder gets a Claude worker on Claude Opus 5.5, with no `/poteto-mode`, when the project grants a Claude token (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` for `api.anthropic.com`). Without one the review is refused, saying so, because a `/login` needs the person. The PR watch skips reviewer threads, because a reviewer's checkout of the branch would link it to the PR it reviews.

Each round goes through the inbox that the PR watch also uses (`src/control/inbox.ts`), so a harness thread gets attributed `nexus.review` input entries and a Claude worker gets the text typed into its session through the steering path. Each request carries a fresh random token that only its recipient is told, which the answer must echo, so neither an earlier answer nor the other agent can answer it. The reviewer reviews the head against the base and ends its reply with a fenced `nexus-review` JSON block: approve or request changes, its findings, each with a priority from P0 to P3 as [the merge policy](merge-policy.md) defines them, the reserved cases the change touches, and its quote of what the PR says could not be checked live. The reviewer approves when no P0 to P2 finding is open, and the loop reads every verdict that way, whatever word the reviewer chose. The builder gets the findings and ends its reply with a `nexus-review-answers` block that fixes or rejects each P0 to P2 finding with a reason. P3 findings come as notes that need no answer: an approval with only P3 findings goes straight to the check, and the builder gets the notes to take up in a later pull request, told not to push to the approved branch. A stored review or an answer whose findings use the earlier `serious` and `minor` reads them as P1 and P3. When it says it fixed something, the loop waits for the PR's head to move, then sends the reviewer the new commits and the answers for the next round. Commits pushed with answers that fixed nothing get a round too, since they are unreviewed. A clean approval runs `.nexus/check` at the approved head, and a failure goes back to the builder as a P0 finding. A builder that answers it without pushing a new head ends the review for the person with the check's output, since the reviewer cannot change the check's result: at once when it rejects the finding, and after the 10 minutes a push may take to show when it says it fixed it. A check that fails again at a head where it failed before goes to the person too. A round is one review, and a round in which the reviewer approves again the head the round before it approved reviewed nothing new, so it does not count against the limit. The loop ends approved, after the rounds a review allows (five unless `--rounds` asks for fewer, and never more than five, even for a review stored with a higher cap), or when an agent stays silent: a turn that ends without a readable block gets a reminder, at most two in a row, and three hours without an answer ends the review. Every message is saved in the review's record before it is sent, under a request ID made from the review and a count of its messages, so a pass after a crash sends it again under the same ID, which the harness and the Claude send both deduplicate. The time the first send began is saved before it too, and the wait for an answer counts from then, so an answer that came before a crash cleared the sent message is still read.

The check runs the pull request's own code, so no pylon whose contents decide a verdict ever runs it, and nothing it writes decides its own result (`src/control/gate.ts`). Each run starts a bare check thread, with no harness conversation and no Claude worker, whose pylon clones the repository at the approved commit. Once that pylon runs, the control plane opens one raw pipe into it, the probe's stream, whose process verifies the checkout's commit and then becomes `.nexus/check` with `exec`. The stream reaches the guest over ssh, whose non-login shell reads no `/etc/profile.d`, so the script first takes the image's environment, its PATH and the egress proxy's CA in `NODE_EXTRA_CA_CERTS` among it, from the guest's PID 1, where Gondolin put it at boot. Unlike the profile files, which `.nexus/setup` runs before the check and could rewrite, that environment is fixed before any of the pull request's code runs. The verdict is that process's exit status as the probe reports the stream's end, and the output's tail goes to the builder when it fails. A check the pylon cannot run goes to the person with its output and costs no round: a check pylon whose boot or `.nexus/setup` failed, a repository with no `.nexus/check`, an image environment the script cannot read, or a command the check needs that the pylon lacks, which the shell reports with exit status 126 or 127. The check thread is deleted after its verdict, so no process the check left behind reaches a later round. Only this control-plane process knows that it opened a run's pipe, so a check thread it holds no run for, as after a restart, or one whose pipe was lost, may have run something already: it is deleted, and the check starts again in a fresh one. A check thread no review holds, such as one started just before a crash, is deleted on the next pass. A Claude reviewer's verdict is still read from its transcript in its own pylon, where the reviewer itself may run the pull request's tests, so code from the change could forge one there. A Claude reviewer's findings still go round, and a review without a landing still ends approved, but its approval never lands: the policy holds a landing it approved for the person. A harness reviewer's verdict is the control plane's own agent loop's answer, out of the pylon's reach.

When the rounds run out, the review ends for the person and the loop adds the label `needs human review` to the pull request, creating the label in the repository if it is missing. The rounds run out in five ways: the reviewer still requests changes after the last round, the builder pushed fixes after the last round so they are unreviewed, `.nexus/check` failed after the last round, the head moved after the last round's approval, or the branch conflicts with its base after the last round, so a rebase could not be reviewed. No other reason a review goes to the person adds the label. The review ends for the person first, with `label.state` `adding`, and a later step of the same pass adds the label, so the person never waits on GitHub. Adding a label GitHub already has changes nothing, so a pass after a crash adds it again safely, and an error GitHub may recover from is retried on the next pass. Labelling needs a token that may write issues or pull requests. When GitHub refuses the control plane's token, the label's state becomes `failed`, and the review gets one more reason that says the label could not be added and GitHub's answer. The loop does not try again, and changing the token stays the person's decision.

A review ends without the person when nothing is left to review. A pull request closed without a merge ends it `closed`. One merged outside a review that does not land ends it `merged`, while a review that lands still decides whether that merge deploys. Before each step the loop reads the PR watch's state, and before it sends a message, starts a check or ends the review it reads the pull request from GitHub, since the watch reads it only every two minutes. A builder or reviewer thread that is archived or deleted, which only the person does, ends the review `cancelled`. Neither ending runs a check, sends a message, adds the label or sets the `decision` attention, and a check thread the review held is deleted. A review already held for the person ends the same way, `closed` or `cancelled`, which clears the `decision` attention, unless it merged: a held deploy or rollback stays with the person whatever happens to the threads.

The record lives in the registry's `reviews` table, keyed by the builder. `reviewed_prs` remembers every pull request a review started for, after a later review of the same builder replaced its record, so a review that starts on its own starts once per pull request. A pass runs every 15 seconds, and each phase reads the world again before it moves: the agents' replies, the PR, the release. A turn's replies are read only after a turn of that agent ended since its last message from the loop. A Claude worker's are its stored transcript, and a harness thread's come from one read of its conversation. A review that ends for the person makes the builder's attention `decision`, whose reasons `nexus show` and the dashboard list.

The builder's page on the dashboard shows a review the person can land above the composer, so the decision needs no terminal and works from a phone: why it waits for them, the reviewer's findings, the check's result, the approved head and the PR. Its Land button asks for a confirmation that names the PR and the commit, then calls the land route with that commit, which lands nothing if the review has moved on, and the page shows the landing's steps, check, merge, deploy and landed, from the review's phases, until it lands or ends for the person again with the reasons, a rollback's among them. The page asks the land route's own questions, whether the browser's device is a deployer and whether the control plane has a review loop, and a device the route would refuse gets a disabled button that says why, while the route still refuses it. Each reason is marked as one the person may waive or not, with why. A reason that holds every landing of the same commit and that the person cannot waive, a Claude reviewer's approval, offers no button, and neither does a review whose pull request closed.

When every reason that would hold the landing again is one [the merge policy](merge-policy.md#what-the-person-may-waive) lets the person waive, the Land button sends those holds with the commit, and its confirmation says it waives them. The review loop checks that the review is landable at that commit and that each hold is one it has now and one the person may waive, then lands as `nexus land` does, and the merge step checks the whole policy again with the named holds met at that commit only. The review records the waiver and the event stream gets `review.waived`. `nexus land` sends no holds, so from the CLI a reserved hold holds the landing again.

With `--land`, or `nexus land <thread>` after an approval, or a project that lands on its own, the loop lands the PR once its check passes. Landing deploys, so it needs the same right as `nexus deploy`, whatever the repository. Right before every merge attempt, including one retried after a restart, it runs all of the policy's checks again with what GitHub says then, and holds for the person with every condition that fails. A head that moved after the approval, such as a builder's rebase on the PR watch's news of a conflict, is not merged: it gets a new round, as a push after findings does, and the reviewer is told to read it against the base, since a rebase rewrites the commits it reviewed. A landing held for nothing but a branch that conflicts with its base, or a merge GitHub refuses while it then reports the conflict, goes back to the builder as a P0 finding, `CONFLICT`: rebase onto the current base, resolve the conflicts keeping both sides' intent, run the checks again and push. The rebased head gets a new round under the same cap, then a check, then the landing. A builder that rejects `CONFLICT`, or pushes nothing for it, ends the review for the person with its reason, and a conflict found after the last round ends it for the person with the label, since no round is left to review a rebase. Then it squash-merges with GitHub's head check, so only the approved commit can merge. A PR of Nexus's own repository, the one releases come from, then deploys: the loop records the release it replaces, sets the merge commit as the desired release, and waits up to 30 minutes for every component to report healthy, as `nexus deploy --wait` does. A failed, rolled-back or late deploy moves to rolling back: the previous release becomes desired again, and the loop waits up to 30 minutes more for every component to report it healthy before it tells the person it rolled back, and that the merge commit is still on the default branch. A rollback that fails too is reported as failed, with the components that failed. The control plane redeploying itself restarts the loop mid-landing, so the merge step saves the head it is about to merge before calling GitHub, and on a restart checks whether the PR merged already, and at the approved head. A merge at a head the review saved is its own. Any other merge, such as the person merging while the check ran, deploys only if every condition of the policy holds, the reserved paths and the reviewer's kind included, and otherwise ends in `decision`, and the deploy and rollback steps check whether their release is already desired, before acting. Once merging, a landing sees its deploy and any rollback through even if its threads are archived. A merged review never lands again.

Merging needs the control plane's GitHub token (`github.tokenFile`) to have write access to the repository's contents and pull requests. A read-only token, enough for the PR watch, makes a landing hold with GitHub's answer, and granting the wider token is the person's decision, as [deployment](../deploy/README.md) says.

### Proposal: the review inside the builder's thread

This is a proposal. It is not built, and it changes `src/control/review.ts`, which other open work is changing now.

Today `nexus review` starts a separate reviewer thread. With the shepherdr mod and pi-shepherdr in the image, a Claude worker builder can run the reviewer itself: pi on the person's `reviewer` profile, in a Herdr tab of the builder's own pylon. That is how the person works on the Mac. The build and its review are then one thread and one pylon. No second pylon boots, and the reviewer reads the builder's working tree, uncommitted changes included.

The control plane keeps what needs a party the builder cannot reach. It still runs `.nexus/check` in a bare check thread and reads the verdict from the exit status. It still caps the rounds and holds a review that runs out for the person. It still re-checks the merge policy before every merge, lands and deploys.

What changes:

1. For a Claude worker builder whose pylon has the ChatGPT grant, `nexus review` sends no reviewer thread. It sends the builder a round request through the inbox, with a fresh token as today. The builder spawns its shepherdr `reviewer` with the pull request's base, or reuses the one from an earlier round, on the pull request's head. A builder without the tool or the login gets today's reviewer thread.
2. The builder fixes or rejects each finding, pushes, and ends its turn with a `nexus-review` block that carries the reviewer's verdict and findings, a `nexus-review-answers` block, and the path of the reviewer's pi session file.
3. The control plane learns the verdict from the builder's Claude transcript, as it reads a Claude reviewer's verdict now, and checks it against the reviewer's own session file, which it reads over the probe's raw pipe. The reviewer's last reply in that file must hold the round's token and the same verdict.
4. Each round counts toward the same cap. A clean approval runs `.nexus/check` as today.

The weakness is that everything in the builder's pylon is the builder's to write. The builder, or the pull request's code that it runs, can edit the reviewer's session file, write a fake one, change the reviewer's profile or prompt, steer the reviewer's input, or skip the review and claim an approval. The token stops a stale answer, not a forged one, because the builder relays it. A Claude reviewer's verdict has the same weakness today, which is why the policy never lands its approval. So an in-thread approval would not land on its own either. Before landing, the control plane would run one confirming round with a reviewer outside the pylon, the harness thread, or hold for the person. Even a reviewer whose model traffic the control plane could read would not be independent, because the builder writes the reviewer's input.

The in-thread review is cheaper and closer to the work, and it catches most findings before the out-of-pylon round sees them. The out-of-pylon verdict stays the only one that lands a pull request.

## Queued threads

`nexus start --after A,B` records a thread now and starts it once A's and B's pull requests have merged, landed by the review loop or merged outside it. Builders branch from the default branch as it is when they start, so the start waits for the merge and not for a deploy. [The CLI's contract](cli.md#queued-threads-0290) has the rules and the types, and `src/control/queue.ts` holds them.

A queued thread is not a `threads` row. It is a record in the registry's `queued_threads` table, keyed by the ID the thread will have, holding the start request as it was asked for, with its size filled in from the project's, the predecessors and a Nexus agent thread's first message. So nothing that reads threads sees it: the planner boots no pylon for it, placement counts no room for it, and the PR watch and the review loop pass it by. Only the API's views, the CLI and the dashboard show it.

The control plane runs one pass over the queue every 15 seconds. A queued thread whose predecessors have all landed, or whose start the person asked for with `nexus start-queued`, starts through the same `threadStarter` a `nexus start` uses, under its recorded ID, so placement, capacity, templates and grants apply as for any start, and an `auto` thread that finds no node with room stays queued until one has it. The transaction that inserts the thread's row and pylon also marks the record started, and refuses when the record is no longer queued, so a start never runs twice and a thread archived while its start was in flight gets no row. The harness hands back the conversation it already made for a thread ID, so the same process can try that start again. A start passes the deploy drain's gate, so a draining control plane refuses it, leaving it queued, and waits for one in flight. The first message goes to the thread under the request ID `queued:<id>` after the start, and the record says whether it was sent, so a pass after a crash sends it again under the same ID, which the harness answers with its first submission.

What each predecessor means is read from its thread, its review and the PR watch's links on every pass and every view, never stored: merged and landed, open or not yet opened and waiting, or blocked because its pull request closed, its review ended for the person, or it was archived, cancelled or deleted before a merge. A blocked thread stays queued and says which predecessor blocks it and why, so the person can start it now or archive it to cancel it. The PR watch stops reading an archived thread's pull requests, a capped watch's, one behind an undelivered message and a closed one, and searches only open ones, so for a thread a queued thread waits for it first reads each unmerged one and searches its branches for any state, and a merge just before an archive, after a reopen, or of a pull request it never saw open is not missed.

## Questions for the person

A question is a record the control plane owns, in the registry's `questions` table: the thread that asked it, the text, two or more options, the merge policy's reserved case it is if any, and who may answer it, a person or a deployer. It generalizes the review's hold for the person, and nothing asks one yet. The orchestration pipeline will ask what the merge policy reserves for the person, as [the exploration](explorations/orchestration.md#asking-the-person-through-the-attention-status) describes. The asker chooses the ID, so asking again after a crash finds the question it asked.

An open question makes its thread's attention `decision`, so it notifies and counts in the badge as a held review does. The thread page shows it as a card above the landing card, with the text and a button per option, each asking for a confirmation, and `nexus show` lists it. The answer is a person-only route, `POST /v1/questions/<id>/answer`, which records the option, the device that chose it and when. An answer never changes: the same option again answers with the stored record, so a retried answer is safe, and another option is refused. As the Land button does, the card asks the route's own question, and a device the route would refuse gets disabled buttons that say why. Acting on the answer is the asker's part, which comes with the pipeline.

## Retry-safe starts

A start with a request ID can be repeated safely, so a client that lost an answer, or a pipeline step that crashed after it asked, sends the same start again instead of checking what exists. The control plane stores the request ID and a hash of the start's body in the transaction that inserts the thread's row, or the queued record, so a start that failed stores nothing and the ID stays free, and one that succeeded is found by every repeat. A repeat that arrives while the first is still starting shares it in the API's memory, which is enough because one control-plane process serves the API. An immediate start's first message goes to the thread under `brief:<thread>` before the start answers, and a repeat sends it again under that ID, which the harness answers with its first submission, so a start and its brief succeed or retry together without a record of whether the message went. The request IDs are global rather than per caller, because every caller is the person's own machine or the control plane. [The CLI reference](cli.md#retry-safe-starts-0340) has the contract.

## Editing project settings

Humans can use `nexus project edit <id>` or `PATCH /v1/projects/<id>` to change placement defaults, branch, resources, allowed hosts, logins, secret grants, git identity and whether builders' pull requests are reviewed and landed on their own. IDs and repository URLs remain fixed. Add and edit share validation; secret hosts must be explicit, nonempty hostname lists. An edit changes only supplied fields; supplied lists replace whole lists, and a null identity removes the override. No agent-facing edit tool is provided. The dashboard's current limited creation dialog is unchanged.

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
agents is worse than asking the person to inspect a possibly started session. A
launch cut off by a probe restart is the exception, as described under
[a launch survives a probe restart](#a-launch-survives-a-probe-restart).
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
The launch fence forbids any other automatic retry.
Persist its session ID before launch so a late turn-started report can clear
stalled attention without another session clearing it; retain the diagnostic
in the event history.

Claude hooks report lifecycle facts through the narrow host bridge. The probe
supplies identity, validates the event, journals a bounded reconnect buffer and
forwards it through observations. Control deduplicates those reports, updates
activity and attention, and appends the public event. A hook never waits on the
probe. It writes its event to an outbox in the pylon, `~/.nexus/outbox`, and
returns, and a sender it starts delivers the outbox in order and deletes each
event once the probe answers, which it does only after journaling the event. A
probe that is down or restarting delays reports instead of losing them, and an
event sent again after a lost answer carries the ID control already applied, so
control ignores it. Every boot, a wake included, starts a sender too, for the
events a pause left behind. So an outbox on a disk that pylons boot from would
reach every one of them: the image build starts no agent, and the hook writes
only in a pylon a thread owns, which has the overlay's `~/.nexus/pylon.json`, so
neither an image nor a template carries one. Running session state is a 30-minute lease independent of
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
never started one. A subagent that dies without a
finish leaves no follow-up turn, and the lease expires as for any silent turn.
Captures are in `docs/verification/claude-background-subagents/`.

A Bash command Claude runs in the background lists as a running `shell` in the
same Stop input, and its finish starts a `<task-notification>` turn too. A shell
may also be a dev server that never finishes, so the Stop reports a heartbeat and
the hook holds the turn end back. Claude Code starts each Bash command as its own
child, leading a process group of its own, which the command keeps through `exec`,
redirected output or closed stdio. Its stdio MCP servers stay in Claude's group.
At the Stop the hook records those groups and starts a detached copy of itself,
the hold, which checks every minute whether a recorded group still has a process.
Each group is recorded with its leader's start time, so a later group that reuses
the ID does not count. Once its leader exits, a group counts only while a member
the hold already saw in it, or one that started before the hold, lives: the kernel
reuses no ID while its group has a process, so a reused group's members are all new. A command that leaves its group, such as one that calls
`setsid`, still counts while a process writes to its output file, which Claude Code
names by session and task ID. While the command runs, the hold sends a heartbeat every five minutes, so
a long build keeps its lease and its pylon. Once it exits, the hold waits 30 seconds
and sends the turn end. Every report carries the Stop's own stamp, so the lease
renews by receipt time, and the turn Claude starts when the command finishes, or a
message from the person, makes the rest stale. One hold owns a session at a time,
because a newer Stop lists every shell still running. Holds start in any order, so
under a lock a hold claims the session only from one for an older Stop, and exits if
the owner's Stop is newer. A replaced hold stops at its next check, and only the
owner releases the claim. At the cap the hold sends the turn end and waits for its
sender to finish before it sends the waiting report, so the turn end cannot remove it.

Nothing tells a dev server from finite work. A command still running after 2 hours
has its turn ended, and the hold also reports `session.waiting` with the message
"A background command was still running after 2 hours", which the dashboard shows
in place of "waiting for input" once the reply is read. A waiting session does not
keep its pylon awake, so with no other activity the pylon pauses after the idle
rules and stops the command. A held process does not survive a pause either, but
before the cap the session is working, so its pylon is not paused.

Claude's Notification hook also fires for an idle prompt, 60 seconds after any
turn ends, even with a background command still running. Only `permission_prompt`,
which AskUserQuestion also fires, and `elicitation_dialog` report waiting. The
event does not say which notification fired, so the control plane cannot drop an
idle prompt without risking a real wait whose turn start was lost or late. Until
the image is rebuilt, the old matcher's idle prompt still counts.

Every Claude in the pylon reads the same hooks, including one a worker starts to
verify its work, whose turn end would otherwise give the thread a reply while the
worker still works. The hook reports, and snapshots a turn, only for a Claude under
the pylon user's own HOME whose process started without `CLAUDE_CODE_SESSION_ID`, which Claude Code puts
in the environment of everything it runs, even after `env -u CLAUDECODE`, and only in a pylon with `~/.nexus/pylon.json`,
which a template build lacks. Sessions
Nexus opens in Herdr panes, the worker's and the person's, start without it.
Captures are in `docs/verification/claude-activity-accuracy/`.

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

### A launch survives a probe restart

A deploy restarts each node's probe, and the probe closes its connections at once.
A Claude worker launch in flight then loses its answer, though the pylon and every
guest command already started keep running, so the launch may have done any part
of its work. The control plane treats a lost probe connection as no answer, not
as a failure. It waits up to three minutes for a snapshot from the probe that came
back and sends the same launch again, under the session ID it recorded before the
first. It does the same for a launch still `starting` when the control plane
itself starts, as after its own deploy.

Sending a prompted launch again is safe because the launch records its progress in
the pylon, in `~/.nexus/claude-launches/<session>/`: `opened` names its workspace
and pane once they exist, `typed` is the claim of the guest command that types the
launch, and `submitted` is the UserPromptSubmit receipt. That command creates
`typed` with `mkdir` and types only if it created it, so of two typing commands,
such as one the stopped probe's guest started late and one from the probe that
replaced it, only one types and the other waits for the receipt. A launch sent again
reads them. If the command was typed, it only waits for the receipt, as the first
one would have, and reports a stall the same way. If nothing was typed, it types
into the pane the first one opened, or opens one if that pane is gone. A launch
from a probe older than these files leaves none, so a pane whose Claude already
runs the session ends it as started, and a session with a transcript but no
running Claude fails without typing, since its prompt already went in. One that an
older probe lost before typing gets a new workspace, and the older probe's empty
shell workspace stays beside it. Captures are in
`docs/verification/launch-survives-deploy/`. The probe
runs the launches, the sends and a wake's relaunch of one session one at a time, so
a launch sent again while the first still runs waits for it and reads what it did.

Every node runs a probe that reads these files, so the control plane sends the
launch again to whichever probe comes back. Snapshots once said so with
`claudeLaunchRepeatable`, which every probe sent as true. Probes no longer send
it, and the control plane ignores it from one that still does. A launch left
`starting` for a deleted thread fails, since its pylon never runs again. Any other
error, or a probe that does not come back in time, fails the launch with the same
diagnostic as before.

The probe does not drain in-flight commands on SIGTERM. A prompted launch can take
over 50 seconds, longer than a drain that fits the unit's 30-second stop timeout,
so a drain could not make launches safe and the retry is needed anyway. The guest
commands a drain would wait for finish on their own, and a drain would delay every
deploy and keep the old probe answering while the new one waits.

Other calls a probe restart can cut:

- Jobs are retried by the control plane until they expire, under the same job ID,
  and the next job converges from wherever an aborted one stopped.
- Closing a session, dropping a failed session and linking or unlinking a port are
  safe to repeat. The person or client that asked gets a 503 and can ask again.
- A transcript or checkout read is read again on the next event or request. A
  check run whose pipe breaks is discarded and runs again in a new check thread.
- A message sent to a Claude worker that loses its answer stays fenced as
  `sending`. A repeat asks the probe with `send-claude-outcome`, but the probe
  keeps that answer in memory, so after a restart the repeat is refused as
  uncertain, though nothing may have been typed. An agent's message is logged and
  not typed again. Surviving a restart needs the same treatment as a launch: a
  record of the request in the pylon, written by the command that types it.
- Opening a session for a person, with no prompt, opens a second workspace if the
  person asks again after a lost answer.

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
(subagents and shells), queue operations, notices, turn durations and the pull
requests Claude opened. Claude Code's
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
the conversation pane renders the entries with the same blocks. While a thread is
watched, its view reads only the entries after the last one it holds, and a read
that found nothing new sends the watchers nothing. A stream whose view has not
changed sends a bare ping, and the client ticks the ages in the page itself. A poll
from a page that streams a Claude worker's conversation names the view it would
show instead of rendering it (`docs/verification/transcript-render-once/`).

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
sending first, and a repeat of a fenced one is never typed. The probe remembers each
send by its request ID until an hour after it settles, so a repeat asks it with
`send-claude-outcome`, which waits for a send still queued behind another and answers
what the send did. A send queued behind a slow one can outlast the control plane's
90-second wait for the probe, and its answer is then lost although the message is
still typed. The repeat reports it. The control plane handles one send per request ID
at a time, so a repeat made while the first is still asked waits for it rather than
sharing its answer. Only a repeat the probe cannot answer, because the
send failed partway or the probe restarted or forgot it, is refused.

The API decides by the thread's Claude worker record before anything else, so no
mode or retry of a Claude worker thread's message reaches the harness. Sending is
human activity: it wakes a paused pylon, and clients retry the 409 until it runs with
the same request ID. A message that comes while the wake still relaunches the session
waits for the relaunch. Captures are in `docs/verification/claude-thread-streaming/`.

### Usage-limit stops (0.21.0)

Claude workers share the project's Claude subscription, so when it runs out, every
worker stops mid-task at once. Claude Code ends each turn with a synthetic assistant
record, `isApiErrorMessage` with `apiError: "usage_limit_reached"` and the reset time
in `apiErrorParams.rate_limit_info.resetsAt`, whose text reads `You've hit your session
limit · resets 5am (UTC)`. It runs the StopFailure hook rather than Stop, so the image
reports that hook as `session.turn-ended` too. The parser marks the record's notice with
`usageLimit` and its reset. The text is Claude Code's rendering of that same field,
so Nexus never parses it.

A stop is a state of the session rather than something to read, so it is its own
attention, `limited`, rather than `waiting` with a message. `waiting` ranks below
`reply`, which the stop's turn end records, so it would never show. It also means
Claude asks the person something, and a stop asks for nothing until the reset. And a
reply clears when it is seen, which a stop must not. The registry derives the stop on
each read of the thread from the newest transcript entries and the session's state,
rather than storing a flag, so it holds whichever of the turn's end and the
transcript's read arrives first, and the next turn ends it, whoever starts it. An
image without the StopFailure hook never reports the turn's end. The stop record then
ends the session's working lease itself, so such a thread does not show `working`
for 30 minutes.

Other API errors stay plain error notices, and the thread shows an unread reply. Claude
Code has already retried an overload or a server error several times before it gives
up, a 429 that is not the usage limit passes in seconds, and neither says when the API
will take a request again. So the person can send "continue" as soon as they read it,
and there is no time to wait for or to show.

Claude Code continues a session it still runs on its own, about 90 seconds after the
reset. That timer lives in the Claude process, so a pylon that paused while the
worker was idle loses it. `nexus send <thread> continue` after the reset always works.
The control plane can also send it, when `resumeAfterUsageLimit` is set in its
config. It is off by default, because it spends the subscription while the person
may be away. Three minutes after the reset, a pass every 30 seconds types one
attributed message into each stopped active or idle thread whose session has not
continued. Its request ID names the session and the stop, so a restart or a second
pass never types it again. It is never typed into an archived thread, so it never
wakes a pylon the person archived. Each message typed appends `usage-limit.continued`
to the event stream. Captures are in `docs/verification/usage-limit-stops/`.
