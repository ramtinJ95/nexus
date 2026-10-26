# Add a project

A user adds a project from the terminal or the dashboard, naming its repository and its node, or asking for a scratch project, whose pylons start from an empty repository. The project then shows in `projects` and the dashboard, and a thread started on it boots a pylon on that node like any other.

## Sub-features

- `project-cli` adds a project with the contract's defaults and prints the `Project`.
- `project-flags` adds a project with every flag set, repeated flags included.
- `project-scratch` adds a scratch project, with no repository URL, and a scratch project with a secret grant.
- `project-list` lists the added projects alongside the seed.
- `project-thread` starts a thread on an added project, and its pylon runs.
- `project-refused` maps an existing ID to exit 5, and an unknown node, both or neither of a URL and `--scratch`, and a malformed `--secret` to exit 64.
- `project-scratch-thread` refuses `--commit` on a scratch project, and boots a thread on one whose pylon guide describes an empty repository.
- `project-ui` adds a project from the dashboard's New project dialog with the same defaults as the CLI, then opens the start dialog on it.
- `project-ui-scratch` adds a scratch project with GitHub access from the dialog, and the start dialog and the overview mark it `scratch`.
- `project-ui-refused` shows the API's message in the dialog for an ID that exists.
- `project-ui-empty` offers `New project` in the empty overview and start dialog, and shows the API's 400 for a bad ID. `scripts/new-project-shots.ts` drives it, because the seeded stack always has a project.

## How to get to it (user POV)

- Run `nexus project add <id> <repo-url> --node <N>`, or `nexus project add <id> --scratch --node <N>`, in a terminal, with `--branch`, `--cpus`, `--memory`, `--disk`, `--allow-host`, `--login` and `--secret NAME:HOST[,HOST]` to override the defaults.
- Choose `New project` at the bottom of the dashboard's sidebar, below the nodes, on any page, or in the overview's header on `/`, `/threads/new` and `/projects/new`, or open `/projects/new`. With no projects, the overview and the start dialog offer `New project` in place of their lists.
- The dialog asks for the ID, the repository, `Clone` with a URL or `Empty (scratch)`, the node, which defaults to `auto, where it fits best`, and the branch, which defaults to `main` and reads `Initial branch` for a scratch project. Its `GitHub access` box grants the project `GH_TOKEN` for `api.github.com` and `github.com`. Other settings need the CLI.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- No project named `quill`, `quill-flags`, `quill-text`, `quill-scratch`, `quill-gh`, `quill-ui` or `quill-ui-scratch` exists in this run. Projects cannot be removed, so this feature runs once per run.

- **CLI add with defaults.** Run `$V cli project-cli -- project add quill https://github.com/octocat/Hello-World.git --node verify-node --json`. Exit 0. Stdout is a `Project` with `id` `quill`, `defaultBranch` `main`, `defaultNode` `verify-node`, `resources` `{"cpus": 2, "memoryGiB": 6, "diskGiB": 10}`, `allowedHosts` `[]`, `secrets` `[]`, `logins` `[]` and `preSetup` null.
- **CLI add with flags.** Run `$V cli project-flags -- project add quill-flags git@github.com:octocat/Spoon-Knife.git --node verify-node --branch dev --cpus 1 --memory 1 --disk 1 --allow-host registry.npmjs.org --allow-host api.stripe.com --login claude --login chatgpt --json`. Exit 0. `defaultBranch` is `dev`, `resources` is `{"cpus": 1, "memoryGiB": 1, "diskGiB": 1}`, `allowedHosts` is `["registry.npmjs.org", "api.stripe.com"]` and `logins` is `["claude", "chatgpt"]`.
- **Text output.** Run `$V cli project-text -- project add quill-text https://github.com/octocat/Hello-World.git --node verify-node`. Exit 0, and stdout is `Added project quill-text (https://github.com/octocat/Hello-World.git) on verify-node`.
- **Scratch.** Run `$V cli project-scratch -- project add quill-scratch --scratch --node verify-node --branch trunk --json`. Exit 0, `repoUrl` is null, `defaultBranch` is `trunk`, and the rest are the defaults. Run `$V cli project-gh -- project add quill-gh --scratch --node verify-node --secret GH_TOKEN:api.github.com,github.com`. Exit 0, and stdout is `Added scratch project quill-gh on verify-node`.
- **List.** Run `$V cli project-list -- projects --json`. The IDs are `quill`, `quill-flags`, `quill-gh`, `quill-scratch`, `quill-text` and `spoon`, the `quill` entry equals the `project-cli` reply, and `quill-gh` has `secrets` `[{"name": "GH_TOKEN", "hosts": ["api.github.com", "github.com"]}]`.
- **Thread on the added project.** Run `$V cli project-thread -- start --project quill --title "project: thread" --json`. Exit 0, and the `Thread`'s `project` is `quill`. Keep its `id` as `TP`. Repeat `$V cli project-thread-show -- show $TP --json` every 5 s until `.pylon.actualState` is `running`, for up to 2 minutes. `.pylon.node` is `verify-node`. Then run `$V pylon project-overlay $TP -- cat /home/user/.nexus/pylon.json`, whose `project` is `quill`.
- **Refusals.**
  - `$V cli project-exists -- project add quill https://github.com/octocat/Hello-World.git --node verify-node --json` exits 5, and stderr is `{"error":"project quill exists","kind":"conflict","status":409}`.
  - `$V cli project-no-node -- project add quill-x https://github.com/octocat/Hello-World.git --node nowhere --json` exits 64, and stderr is `{"error":"no node nowhere","kind":"invalid","status":400}`.
  - `$V cli project-neither -- project add quill-x --node verify-node --json` and `$V cli project-both -- project add quill-x https://github.com/octocat/Hello-World.git --scratch --node verify-node --json` each exit 64 with stderr `{"error":"project add takes a <repo-url> or --scratch, and not both","kind":"invalid","status":null}`.
  - `$V cli project-bad-secret -- project add quill-x --scratch --node verify-node --secret GH_TOKEN=abc --json` exits 64 before any request. Its `error` starts `--secret takes NAME:HOST[,HOST...]` and never echoes `abc`.
  - `$V cli project-after -- projects --json` still lists six projects, so no refusal created one.
- **Scratch thread.** `$V cli project-scratch-commit -- start --project quill-scratch --title "project: scratch commit" --commit abc123 --json` exits 64 with stderr `{"error":"project quill-scratch is a scratch project, so it has no commit to check out","kind":"invalid","status":400}`. Then start `project: scratch` on `quill-scratch` as `TS` and poll until it runs. `$V pylon project-scratch-guide $TS -- cat /home/user/.nexus/PYLON.md` says the checkout `is a new repository on branch trunk with no commits and no remote`, and gives the `nexus project add <id> --scratch --secret GH_TOKEN:api.github.com,github.com` advice for a project without a token.
- **Dashboard add.** Open the dialog and submit it:
  - Run `$V browser project-ui-side -- click "a.side-add"` on any page, the button at the bottom of the sidebar, and `$V browser project-ui-header -- click "header.bar a[data-new-project]"` on `/`. Each opens the `New project` dialog: `eval "() => document.getElementById('project-dialog').open"` prints `true`. Close it with `press Escape` and `goto http://127.0.0.1:7470/` before the next one, because the open dialog is modal and blocks the next click.
  - Run `$V browser project-ui-open -- goto http://127.0.0.1:7470/projects/new`. The `New project` dialog is open, with `auto, where it fits best` chosen under `Node` and `main` under `Branch`.
  - Run `$V browser project-ui-id -- fill "#project-id" "quill-ui"` and `$V browser project-ui-repo -- fill "#project-repo" "https://github.com/octocat/Hello-World.git"`.
  - Run `$V browser project-ui-submit -- click "#project button[type=submit]"`. The `New project` dialog closes and the `Start a thread` dialog opens with `quill-ui` checked under `Project`. The sidebar and the overview list `quill-ui`.
  - Capture it with `$V browser project-ui-snap -- snapshot --filename project-ui.md` and `$V browser project-ui-shot -- screenshot --filename project-ui.png`.
  - Confirm from the CLI: in `$V cli project-ui-list -- projects --json`, the `quill-ui` entry equals the `project-cli` reply apart from its `id` and its `defaultNode`, which is `auto`.
- **Dashboard scratch add.** Run `$V browser project-ui-scratch-open -- goto http://127.0.0.1:7470/projects/new` and fill `#project-id` with `quill-ui-scratch`.
  - Run `$V browser project-ui-scratch-kind -- click '#project label:has(input[name=repoKind][value=scratch])'`. Then `eval "() => [document.getElementById('project-repo').hidden, document.querySelector('label[for=project-branch]').textContent]"` prints `[true,"Initial branch"]`.
  - Run `check '#project input[name=github]'`, then `click "#project button[type=submit]"`. The start dialog opens with `quill-ui-scratch` checked, its row reads `scratch`, and `#start-hint` reads `Boots a pylon on the node with the most room left from image img-0000000000aa and starts an empty repository on main.` The overview's `quill-ui-scratch` section reads `scratch, no remote`. Capture `snapshot --filename project-ui-scratch.md` and `screenshot --filename project-ui-scratch.png`.
  - In `$V cli project-ui-scratch-list -- projects --json`, `quill-ui-scratch` has `repoUrl` null and the same `GH_TOKEN` secret as `quill-gh`, and there are eight projects.
- **Dashboard refusal.** Run `$V browser project-ui-again -- goto http://127.0.0.1:7470/projects/new`, fill `#project-id` with `quill` and `#project-repo` with any URL, and click `#project button[type=submit]`. The dialog stays open, and `#project-error` reads `project quill exists`. Capture `snapshot --filename project-ui-refused.md` and `screenshot --filename project-ui-refused.png`.
- **Empty states and a bad ID.** Run `node .claude/skills/verify-nexus/scripts/new-project-shots.ts`. It prints an `ok:` line per check and `all checks passed, screenshots in <dir>`, and exits 0.
- **Proof.** The recorded `project-cli`, `project-flags`, `project-text`, `project-scratch`, `project-gh`, `project-list`, the `project-thread-show` that reads `running`, `project-overlay`, the six refusals and `project-after`, `project-scratch-commit`, `project-scratch-guide`, the two entry-point checks, then `project-ui.md`, `project-ui.png`, `project-ui-list`, `project-ui-scratch.md`, `project-ui-scratch.png`, `project-ui-scratch-list`, `project-ui-refused.md`, `project-ui-refused.png` and the script's output.

## Gotchas

- Projects cannot be removed, so after this feature `projects` lists eight, and [Browse threads](./browse-threads.md)'s `browse-projects` no longer returns `spoon` alone. The start dialog also opens on `quill`, the first project by ID, instead of `spoon`, so [Start a thread](./start-thread.md) names its project in the URL.
- The stack's pylons never clone, so the repository URL only labels the project, and an SSH URL such as `git@github.com:…` boots the same as an HTTPS one. The Docker backend does not enforce resources either. A real node's clone is proven by `src/control/thread-on-node.ts`, not here. Neither proves that a pylon gets the project's memory or CPUs.
- Run the dashboard steps after `project-after`, which counts six projects.
- Don't start a thread on `quill-gh` or `quill-ui-scratch`. The stack's node has no secret file, so a pylon granted `GH_TOKEN` never runs: `show` reads `failed` with `last job failed with secret-missing, which is not retryable: secret GH_TOKEN is not in this node's secret file`.
- A scratch project's pylon here still boots the image's one-commit repo, so its `changes` show that commit as the base. Only the record, the `--commit` refusal and the pylon's guide show it is scratch. This stack does not prove a real node's empty repository.
- Click the `Empty (scratch)` label, not its radio input. The label's text covers the input, so `click '#project input[name=repoKind][value=scratch]'` times out.
- The seed always has `spoon`, so the stack cannot show the dashboard's empty states. `scripts/new-project-shots.ts` runs its own control plane with no projects for them, on port 7490.
- The dialog's nodes are those of the page it opened on. A node that came online since then is not the default until the page reloads.
- Start the thread on `quill`, not `quill-flags`. Its logins and allowed hosts change nothing in a Docker pylon, which has no network policy.
