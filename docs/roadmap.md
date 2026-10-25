# Nexus roadmap

This page lists the work planned for Nexus and its clients: the web dashboard, the Claude Code mod in `claude-mods`, and the `pi-nexus` extension. When an item lands, take it off this page and update the docs that describe the behaviour. Decisions go in [the design's decision table](design.md#decisions), and unknowns that need a spike go under [open questions](design.md#open-questions).

Several items copy ideas from [t3code](https://github.com/pingdotgg/t3code), which is MIT licensed. Code copied from it keeps its copyright notice beside the code.

## In progress

Nexus threads are building these, one pull request each. They are dogfooding Nexus.

- **Deploys that agents can run.** `nexus deploy <commit>` records the release Nexus should run, and a small root deployer on each node pulls it. It ships only commits on `main`, upgrades the control plane before the probes, waits for running turns, and rolls itself back when the health check fails. Only nodes listed in `control.json` may deploy, never agents inside pylons. Installing the deployer takes sudo once per node. After that, no deploy needs a password or SSH.

## Next

These start once the work above has landed.

- **The clients use the attention status, the seen marker and the latest-turn base.** The mod and pi-nexus drop their own seen stores (the mod's store and `pi-nexus/viewed.json`) and read the control plane's fields instead.
- **Dashboard polish.** A live "working 1m 03s" clock on running rows. Rows that don't need you dimmed. Tool calls in the conversation grouped into summaries such as "Ran 3 commands, changed 2 files".
- **Syntax-highlighted diffs.** The dashboard renders its diffs with Pierre's diff library, [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs), which t3code's web app also uses, so changed code gets proper syntax highlighting instead of today's plain lines. Check its licence before adding it.
- **Review comments on the diff.** The dashboard's diff works like the review-pane mod's `/review-diff`. Select a line or a range and attach a comment, a question, a suggestion or a requested change. The notes gather into one review, which goes to the composer with each note's file and lines, so the person edits it before it reaches the agent. An answer to a question shows beside the lines it was asked about. When the thread has a pull request, the review could also go to GitHub as review comments, and the pull request's own review comments could show in place, building on the pull request watch.
- **A git identity in every pylon.** A scratch pylon has no git `user.name` or `user.email`, so an agent there can't commit. Headless Claude Code hit this in the Claude Code spike and stopped to ask who to commit as. The common dotfiles layer or the project could set it.
- **Serve the dashboard over HTTPS,** for example through `tailscale serve`. Browsers allow system notifications only in a secure context, and the dashboard is plain HTTP today.

## Later

- **Placement by a scheduler.** A client or an agent submits work without naming a node, and Nexus boots the pylon on the node where it fits with the least load. Today every thread boots on its project's default node, unless the CLI's `start --node` names another. The scheduler needs these first:
  - `nexus nodes` reports `committedMemoryGiB: 0` on a node running five 8 GiB pylons, so the capacity it reports is wrong.
  - A project's default node and resources can't be changed once it is created.
  - The model tools' `start` takes no node.
  - There is no move job, so a pylon stays on the node it booted on. [The lifecycle](design.md#lifecycle-follows-amp) describes how a move could work, and spike S7 showed that copying checkpoints needs verifying.
- **Tools for an agent to drive other threads.** Delegate a task, send to a thread, wait on it and read it, with retry-safe request IDs and a cap on what a child thread may do. The agent loop runs on the control plane, so these tools could run there. Whether pi-durable can run a tool on the host rather than in the pylon is unchecked.
- **Rethink how work is orchestrated.** Revisit this after more of the roadmap has been built through Nexus. Today the coordinator is a Claude Code chat on the Mac. It moves only while it has a turn, so the whole pipeline stops whenever it waits on the person. On 2026-10-25 it stopped three ways. The coordinator asked the person about calls it could have made, such as merging a reviewed PR whose live check couldn't run locally. A thread stopped at a draft and no one noticed until it was read. A deploy needed a sudo password. A coordinator that runs inside Nexus could fix this, reacting to attention changes and pull request events instead of polling. It would act alone within a written policy (review, live check, merge, deploy) and bring the person only real decisions, through the attention status. It builds on the tools above and on deploys that agents can run.
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
