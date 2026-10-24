# Nexus verification map

This directory is the maintained source for verifying what a Nexus user can do with threads. Read this index before driving the stack, then use the matching feature file as the recipe. The harness is `scripts/verify-nexus`, abbreviated `$V` below. [`../SKILL.md`](../SKILL.md) explains the stack, its doubles and its evidence.

## Baseline preconditions

- Run from the repo root with `V=.claude/skills/verify-nexus/scripts/verify-nexus`.
- `$V up` printed `ready`, and `$V doctor` exits 0 for the current run. Never drive a stack that `$V up` did not start in this run.
- The seed is in place: project `spoon` on node `verify-node`, current image `img-0000000000aa`, and nothing else. `up` refuses to report ready without it, and the evidence's `stack-state.json` records it.
- Threads persist for the life of a run. A feature that needs a fresh thread starts its own, and each title says which feature made it.
- The model is scripted. A message that starts with `bash: ` runs that command as one bash tool call in the pylon, then answers `scripted answer after toolResult`. A message `stream: <n>` gets an answer of n words that streams one word every 20 ms. Any other message gets `scripted answer after user`.

## Driving conventions

- Run the Mac CLI through `$V cli <step> -- <nexus args> --json`. Assert on the JSON, never on the plain-text output, which `docs/cli.md` leaves out of the contract.
- Run the dashboard through `$V browser <step> -- <playwright-cli args>`. Open the session once with `$V browser open -- open http://127.0.0.1:7470/`. Prefer element IDs and roles from the dashboard (`#start-title`, `#prompt-text`, `#send`, `#archive`, `#unarchive`, `#delete`, `role=link[name="<title>"]`) over snapshot refs, which change with every render.
- Pylon state converges on the loop's 5 s tick, and the dashboard refetches every 5 s. Poll `show`, or repeat a `snapshot`, every 3 to 5 s with a deadline, usually 2 minutes, instead of sleeping a fixed time.
- A bare command in a recipe, such as `show $T --json`, means `$V cli <step> -- show $T --json`. Name the step after the feature ID.
- `$V pylon <step> <thread> -- <cmd>` only observes a pylon's disk. Never use it to cause what you are proving.
- Treat every command as literal. Keep thread IDs from the `start` reply, never from a list position.

## Proof and skip reporting

- Capture the user action and the resulting state as separate recorded steps.
- CLI proof is the recorded `.cmd`, `.stdout`, `.stderr` and `.exit`, which `$V cli` writes on its own.
- Dashboard proof is a snapshot (`snapshot --filename <name>.md`) plus a screenshot (`screenshot --filename <name>.png`) of the resulting state, with the thread title visible.
- Every mutation needs a second, read-only view, such as `show` after `archive`, or the CLI after a dashboard click, plus the Docker side effect the feature names.
- Name the feature ID and entry point in each step name, such as `msg-cli-send` or `archive-ui-click`.
- Report an unreachable entry point with the command you tried and the unmet precondition. Never report a skipped entry point as verified through a sibling.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections, in this order:

1. `Sub-features` lists short IDs, with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-nexus` starts with `Preconditions:`. Its labeled bullets pair each user action with an exact command and an observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands and observable proof.

## Features

- [Add a project](./add-project.md) covers CLI `project add` with its defaults and flags, the added project in `projects`, a thread that boots on it, and the conflict and invalid exits.
- [Start a thread](./start-thread.md) covers the CLI `start`, the dashboard's start dialog, title rules, and a booted pylon with its overlay.
- [Message the agent](./message-agent.md) covers CLI `send` and `conversation`, the dashboard composer, request-ID deduplication, and a tool call's effect on the pylon's disk.
- [Archive and unarchive](./archive-thread.md) covers pausing a thread's pylon to a checkpoint, refusing messages while it is archived, and waking it with its disk intact.
- [Delete a thread](./delete-thread.md) covers CLI and dashboard delete, a `watch` that ends on deletion, and the removal of the pylon and its checkpoints.
- [Browse threads](./browse-threads.md) covers `threads`, `projects`, `nodes`, the dashboard overview and sidebar filter, and the CLI's not-found and invalid exits.
- [Preview a listening port](./preview-port.md) covers CLI `ports`, `preview --wait` and `unpreview`, the dashboard's Ports section with its `Open` button and the `Unpublish` button under Previews, fetching the preview through the gateway, keeping its URL across a wake, and keeping an unpublished port unpublished across one.
- [Stream an answer](./stream-answer.md) covers `watch --json` printing an answer as it is written, the thread page growing it in place, a reader's scroll position while it grows, and a hidden tab letting go of its stream.

Not yet mapped: declared previews and outputs. Both need the in-pylon `nexus` CLI, which cannot reach the probe from a Docker pylon (see [Message the agent](./message-agent.md) Gotchas). Herdr sessions, `retry`, `retry-pylon`, `abort` and `wake` are also unmapped.
