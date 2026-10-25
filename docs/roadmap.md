# Nexus roadmap

This page lists the work planned for Nexus and its clients: the web dashboard, the Claude Code mod in `claude-mods`, and the `pi-nexus` extension. When an item lands, take it off this page and update the docs that describe the behaviour. Decisions go in [the design's decision table](design.md#decisions), and unknowns that need a spike go under [open questions](design.md#open-questions).

Several items copy ideas from [t3code](https://github.com/pingdotgg/t3code), which is MIT licensed. Code copied from it keeps its copyright notice beside the code.

## In progress

Nexus threads are building these, one pull request each. They are dogfooding Nexus.

- **One attention status and a shared seen marker.** The control plane works out each thread's `attention` (failed, parked, an unseen reply, working) and stores when a person last saw its latest reply. All three clients show the same thing, and parked threads show up even when no client watches them. Marking a thread seen must never count as human activity, so it never wakes a pylon.
- **Dashboard notifications.** These build on the attention status. Something that needs you notifies at once. A finished run waits 2 seconds, in case a follow-up starts. Threads present at page load stay silent. A toast shows when the dashboard is focused, a system notification when it isn't, and the favicon and title show a count.
- **A "Latest turn" base in Changes.** A snapshot per turn, kept as a hidden git ref, shows what the agent's last turn changed, beside "since the pylon booted" and "uncommitted".
- **Pull request watch.** The control plane links a thread's pushed branch to its open pull request and polls it. It wakes the agent when checks fail, someone comments or reviews, or the branch conflicts. It stops on merge or close, or after 10 wakes in a row that brought only comments.
- **Project tools for agents.** `projects` and `project_add` in the mod and in pi-nexus, so an agent can add a project. The only secret an agent can grant is `GH_TOKEN` to github.com and api.github.com.
- **Deferred pi tools.** pi-nexus registers its tools so they load only when pi's tool search finds them ([pi-nexus#13](https://github.com/ramtinJ95/pi-nexus/pull/13)).

## Next

These start once the work above has landed.

- **The clients use the attention status, the seen marker and the latest-turn base.** The mod and pi-nexus drop their own seen stores (the mod's store and `pi-nexus/viewed.json`) and read the control plane's fields instead.
- **Dashboard polish.** A live "working 1m 03s" clock on running rows. Rows that don't need you dimmed. Tool calls in the conversation grouped into summaries such as "Ran 3 commands, changed 2 files".
- **Serve the dashboard over HTTPS,** for example through `tailscale serve`. Browsers allow system notifications only in a secure context, and the dashboard is plain HTTP today.

## Later

- **Placement by a scheduler.** A client or an agent submits work without naming a node, and Nexus boots the pylon on the node where it fits with the least load. Today every thread boots on its project's default node, unless the CLI's `start --node` names another. The scheduler needs these first:
  - `nexus nodes` reports `committedMemoryGiB: 0` on a node running five 8 GiB pylons, so the capacity it reports is wrong.
  - A project's default node and resources can't be changed once it is created.
  - The model tools' `start` takes no node.
  - There is no move job, so a pylon stays on the node it booted on. [The lifecycle](design.md#lifecycle-follows-amp) describes how a move could work, and spike S7 showed that copying checkpoints needs verifying.
- **Turning diff comments into a message.** Select lines in the dashboard's diff, write a note, and the note goes to the composer with its file and lines.
- **Tools for an agent to drive other threads.** Delegate a task, send to a thread, wait on it and read it, with retry-safe request IDs and a cap on what a child thread may do. The agent loop runs on the control plane, so these tools could run there. Whether pi-durable can run a tool on the host rather than in the pylon is unchecked.
- **An agent asking for a secret.** A card in the dashboard where the person enters the value. The agent gets only a reference, and Gondolin's placeholder swap delivers the value. Today a project's secrets are fixed when it is created.
- **Forking a thread.** Start a new thread from a point in another one. It needs a copy of the source pylon's disk, which is the same problem as the move job.
- **Templates at thread start.** The backend already builds templates, which would skip `.nexus/setup`, but starting a thread doesn't use them yet.
- **Named pylons that outlive a thread.**
- **A shared credential service,** so that Claude Code and Codex don't need a `/login` in every new pylon.
- **Deleting a thread's conversation from the harness.** pi-durable can't delete one yet, so a deleted thread's transcript stays in the harness's storage.
- **A Firecracker backend.**
- **Phone steering through Claude Code Remote Control.** This is low priority, because Nexus is rarely used from a phone.

## Not planned

These come from t3code, and we decided against them for Nexus:

- **Event sourcing** with an effect outbox and projections. pi-durable, the registry and the pure planner already make Nexus durable.
- **Remote access machinery,** such as several routes per machine, pairing links, a relay, OAuth and guest links. The tailnet and its whois check already cover a single user.
- **Approvals and permission modes.** Pylons run unattended in a VM with an egress allowlist, and approval prompts would stop work while you're away.
- **Settle and snooze shelves.** Idle pylons already pause, and archived threads fold away.
