# Add a project

A user adds a project from the terminal, naming its repository and its node. The project then shows in `projects`, and a thread started on it boots a pylon on that node like any other.

## Sub-features

- `project-cli` adds a project with the contract's defaults and prints the `Project`.
- `project-flags` adds a project with every flag set, repeated flags included.
- `project-list` lists the added projects alongside the seed.
- `project-thread` starts a thread on an added project, and its pylon runs.
- `project-refused` maps an existing ID to exit 5, an unknown node to exit 64, and a missing `--node` to exit 64.

## How to get to it (user POV)

- Run `nexus project add <id> <repo-url> --node <N>` in a terminal, with `--branch`, `--cpus`, `--memory`, `--disk`, `--allow-host` and `--login` to override the defaults.
- The dashboard has no way to add a project. With no projects, it points to `nexus project add`.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- No project named `quill` or `quill-flags` exists in this run. Projects cannot be removed, so this feature runs once per run.

- **CLI add with defaults.** Run `$V cli project-cli -- project add quill https://github.com/octocat/Hello-World.git --node verify-node --json`. Exit 0. Stdout is a `Project` with `id` `quill`, `defaultBranch` `main`, `defaultNode` `verify-node`, `resources` `{"cpus": 2, "memoryGiB": 4, "diskGiB": 10}`, `allowedHosts` `[]`, `secrets` `[]`, `logins` `[]` and `preSetup` null.
- **CLI add with flags.** Run `$V cli project-flags -- project add quill-flags git@github.com:octocat/Spoon-Knife.git --node verify-node --branch dev --cpus 1 --memory 1 --disk 1 --allow-host registry.npmjs.org --allow-host api.stripe.com --login claude --login chatgpt --json`. Exit 0. `defaultBranch` is `dev`, `resources` is `{"cpus": 1, "memoryGiB": 1, "diskGiB": 1}`, `allowedHosts` is `["registry.npmjs.org", "api.stripe.com"]` and `logins` is `["claude", "chatgpt"]`.
- **Text output.** Run `$V cli project-text -- project add quill-text https://github.com/octocat/Hello-World.git --node verify-node`. Exit 0, and stdout is `Added project quill-text (https://github.com/octocat/Hello-World.git) on verify-node`.
- **List.** Run `$V cli project-list -- projects --json`. The IDs are `quill`, `quill-flags`, `quill-text` and `spoon`, and the `quill` entry equals the `project-cli` reply.
- **Thread on the added project.** Run `$V cli project-thread -- start --project quill --title "project: thread" --json`. Exit 0, and the `Thread`'s `project` is `quill`. Keep its `id` as `TP`. Repeat `$V cli project-thread-show -- show $TP --json` every 5 s until `.pylon.actualState` is `running`, for up to 2 minutes. `.pylon.node` is `verify-node`. Then run `$V pylon project-overlay $TP -- cat /home/user/.nexus/pylon.json`, whose `project` is `quill`.
- **Refusals.**
  - `$V cli project-exists -- project add quill https://github.com/octocat/Hello-World.git --node verify-node --json` exits 5 with `"kind": "conflict"`, `"status": 409` and `"error": "project quill exists"`.
  - `$V cli project-no-node -- project add quill-x https://github.com/octocat/Hello-World.git --node nowhere --json` exits 64 with `"kind": "invalid"`, `"status": 400` and `"error": "no node nowhere"`.
  - `$V cli project-missing-node -- project add quill-x https://github.com/octocat/Hello-World.git --json` exits 64 with `"kind": "invalid"`, `"status": null` and `"error": "project add needs --node. Run nexus nodes to list them"`.
  - `$V cli project-after -- projects --json` still lists four projects, so no refusal created one.
- **Proof.** The recorded `project-cli`, `project-flags`, `project-text`, `project-list`, the `project-thread-show` that reads `running`, `project-overlay`, the three refusals and `project-after`.

## Gotchas

- Projects cannot be removed, so after this feature `projects` lists four, and [Browse threads](./browse-threads.md)'s `browse-projects` no longer returns `spoon` alone. Run Browse threads first, or expect the `quill` projects there.
- The stack's pylons never clone, so the repository URL only labels the project, and an SSH URL such as `git@github.com:…` boots the same as an HTTPS one. The Docker backend does not enforce resources either. A real node's clone is proven by `src/control/thread-on-node.ts`, not here. Neither proves that a pylon gets the project's memory or CPUs.
- Start the thread on `quill`, not `quill-flags`. Its logins and allowed hosts change nothing in a Docker pylon, which has no network policy.
