# Add a project

A user adds a project from the terminal or the dashboard, naming its repository and its node. The project then shows in `projects` and the dashboard, and a thread started on it boots a pylon on that node like any other.

## Sub-features

- `project-cli` adds a project with the contract's defaults and prints the `Project`.
- `project-flags` adds a project with every flag set, repeated flags included.
- `project-list` lists the added projects alongside the seed.
- `project-thread` starts a thread on an added project, and its pylon runs.
- `project-refused` maps an existing ID to exit 5, an unknown node to exit 64, and a missing `--node` to exit 64.
- `project-ui` adds a project from the dashboard's New project dialog with the same defaults as the CLI, then opens the start dialog on it.
- `project-ui-refused` shows the API's message in the dialog for an ID that exists.
- `project-ui-empty` offers `New project` in the empty overview and start dialog, and shows the API's 400 for a bad ID. `scripts/new-project-shots.ts` drives it, because the seeded stack always has a project.

## How to get to it (user POV)

- Run `nexus project add <id> <repo-url> --node <N>` in a terminal, with `--branch`, `--cpus`, `--memory`, `--disk`, `--allow-host` and `--login` to override the defaults.
- Choose `New project` in the dashboard's sidebar, under the projects, on any page, or in the overview's header on `/`, `/threads/new` and `/projects/new`, or open `/projects/new`. With no projects, the overview and the start dialog offer `New project` in place of their lists.
- The dialog asks for the ID, the repository URL, the node, which defaults to the first online one, and the branch, which defaults to `main`. Other settings need the CLI.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- No project named `quill`, `quill-flags`, `quill-text` or `quill-ui` exists in this run. Projects cannot be removed, so this feature runs once per run.

- **CLI add with defaults.** Run `$V cli project-cli -- project add quill https://github.com/octocat/Hello-World.git --node verify-node --json`. Exit 0. Stdout is a `Project` with `id` `quill`, `defaultBranch` `main`, `defaultNode` `verify-node`, `resources` `{"cpus": 2, "memoryGiB": 4, "diskGiB": 10}`, `allowedHosts` `[]`, `secrets` `[]`, `logins` `[]` and `preSetup` null.
- **CLI add with flags.** Run `$V cli project-flags -- project add quill-flags git@github.com:octocat/Spoon-Knife.git --node verify-node --branch dev --cpus 1 --memory 1 --disk 1 --allow-host registry.npmjs.org --allow-host api.stripe.com --login claude --login chatgpt --json`. Exit 0. `defaultBranch` is `dev`, `resources` is `{"cpus": 1, "memoryGiB": 1, "diskGiB": 1}`, `allowedHosts` is `["registry.npmjs.org", "api.stripe.com"]` and `logins` is `["claude", "chatgpt"]`.
- **Text output.** Run `$V cli project-text -- project add quill-text https://github.com/octocat/Hello-World.git --node verify-node`. Exit 0, and stdout is `Added project quill-text (https://github.com/octocat/Hello-World.git) on verify-node`.
- **List.** Run `$V cli project-list -- projects --json`. The IDs are `quill`, `quill-flags`, `quill-text` and `spoon`, and the `quill` entry equals the `project-cli` reply.
- **Thread on the added project.** Run `$V cli project-thread -- start --project quill --title "project: thread" --json`. Exit 0, and the `Thread`'s `project` is `quill`. Keep its `id` as `TP`. Repeat `$V cli project-thread-show -- show $TP --json` every 5 s until `.pylon.actualState` is `running`, for up to 2 minutes. `.pylon.node` is `verify-node`. Then run `$V pylon project-overlay $TP -- cat /home/user/.nexus/pylon.json`, whose `project` is `quill`.
- **Refusals.**
  - `$V cli project-exists -- project add quill https://github.com/octocat/Hello-World.git --node verify-node --json` exits 5, and stderr is `{"error":"project quill exists","kind":"conflict","status":409}`.
  - `$V cli project-no-node -- project add quill-x https://github.com/octocat/Hello-World.git --node nowhere --json` exits 64, and stderr is `{"error":"no node nowhere","kind":"invalid","status":400}`.
  - `$V cli project-missing-node -- project add quill-x https://github.com/octocat/Hello-World.git --json` exits 64 before any request, and stderr is `{"error":"project add needs --node. Run nexus nodes to list them","kind":"invalid","status":null}`.
  - `$V cli project-after -- projects --json` still lists four projects, so no refusal created one.
- **Dashboard add.** Open the dialog and submit it:
  - Run `$V browser project-ui-side -- click "a.side-add"` on any page, and `$V browser project-ui-header -- click "header.bar a[data-new-project]"` on `/`. Each opens the `New project` dialog: `eval "() => document.getElementById('project-dialog').open"` prints `true`.
  - Run `$V browser project-ui-open -- goto http://127.0.0.1:7470/projects/new`. The `New project` dialog is open, with `verify-node` chosen under `Node` and `main` under `Branch`.
  - Run `$V browser project-ui-id -- fill "#project-id" "quill-ui"` and `$V browser project-ui-repo -- fill "#project-repo" "https://github.com/octocat/Hello-World.git"`.
  - Run `$V browser project-ui-submit -- click "#project button[type=submit]"`. The `New project` dialog closes and the `Start a thread` dialog opens with `quill-ui` checked under `Project`. The sidebar and the overview list `quill-ui`.
  - Capture it with `$V browser project-ui-snap -- snapshot --filename project-ui.md` and `$V browser project-ui-shot -- screenshot --filename project-ui.png`.
  - Confirm from the CLI: in `$V cli project-ui-list -- projects --json`, the `quill-ui` entry equals the `project-cli` reply apart from its `id`.
- **Dashboard refusal.** Run `$V browser project-ui-again -- goto http://127.0.0.1:7470/projects/new`, fill `#project-id` with `quill` and `#project-repo` with any URL, and click `#project button[type=submit]`. The dialog stays open, and `#project-error` reads `project quill exists`. Capture `snapshot --filename project-ui-refused.md` and `screenshot --filename project-ui-refused.png`.
- **Empty states and a bad ID.** Run `node .claude/skills/verify-nexus/scripts/new-project-shots.ts`. It prints an `ok:` line per check and `all checks passed, screenshots in <dir>`, and exits 0.
- **Proof.** The recorded `project-cli`, `project-flags`, `project-text`, `project-list`, the `project-thread-show` that reads `running`, `project-overlay`, the three refusals and `project-after`, the two entry-point checks, then `project-ui.md`, `project-ui.png`, `project-ui-list`, `project-ui-refused.md`, `project-ui-refused.png` and the script's output.

## Gotchas

- Projects cannot be removed, so after this feature `projects` lists five, and [Browse threads](./browse-threads.md)'s `browse-projects` no longer returns `spoon` alone. The start dialog also opens on `quill`, the first project by ID, instead of `spoon`, so [Start a thread](./start-thread.md) names its project in the URL.
- The stack's pylons never clone, so the repository URL only labels the project, and an SSH URL such as `git@github.com:…` boots the same as an HTTPS one. The Docker backend does not enforce resources either. A real node's clone is proven by `src/control/thread-on-node.ts`, not here. Neither proves that a pylon gets the project's memory or CPUs.
- Run the dashboard steps after `project-after`, which counts four projects.
- The seed always has `spoon`, so the stack cannot show the dashboard's empty states. `scripts/new-project-shots.ts` runs its own control plane with no projects for them, on port 7490.
- The dialog's nodes are those of the page it opened on. A node that came online since then is not the default until the page reloads.
- Start the thread on `quill`, not `quill-flags`. Its logins and allowed hosts change nothing in a Docker pylon, which has no network policy.
