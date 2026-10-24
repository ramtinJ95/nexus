# Browse threads

A user finds threads and the state of their pylons from the terminal or the dashboard. The CLI lists threads, projects and nodes, and the dashboard groups threads by project, with a sidebar filter. Bad input gets a precise exit code instead of a guess.

## Sub-features

- `browse-threads` lists open threads with each pylon's desired and observed state.
- `browse-project` narrows the list to one project.
- `browse-meta` lists projects and nodes.
- `browse-ui` shows the overview's project sections, the sidebar's project folders and its nodes, and filters the sidebar by title.
- `browse-fold` folds a project in the sidebar, and a filter that matches opens it until the filter is cleared.
- `browse-errors` maps an unknown thread to exit 4, bad arguments to exit 64, and an unreachable API to exit 2.

## How to get to it (user POV)

- Run `nexus threads [--project P] [--all]`, `nexus show <thread>`, `nexus projects` and `nexus nodes` in a terminal.
- Open the dashboard at `/`, type into `Filter threads` in the sidebar, and choose a thread's link to open its page. Each project in the sidebar is a folder with its default branch, which a click folds, and the sidebar lists the nodes below the projects.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Two threads exist and run: `browse: alpha` (`TA`) and `browse: beta` (`TB`), both started with `$V cli … start --project spoon --title … --json` right before this feature. A thread pauses after 20 minutes without human activity and 5 without agent activity, and then its `desired` reads `paused`.

- **List threads.** Run `$V cli browse-threads -- threads --json`. It holds rows for `TA` and `TB`. Each row has `desired` `running` and `pylon.actualState` `running`, on node `verify-node`.
- **One project.** Run `$V cli browse-project -- threads --project spoon --json`, which returns the same rows. Then run `$V cli browse-project-none -- threads --project nope --json`. Exit 0, and stdout is `[]`.
- **Projects and nodes.** `$V cli browse-projects -- projects --json` returns one project, `spoon`, unless [Add a project](./add-project.md) ran earlier in this run. `$V cli browse-nodes -- nodes --json` returns `verify-node` with `state` `online` and a recent `observedAt`.
- **Dashboard overview.** Run `$V browser browse-ui-open -- goto http://127.0.0.1:7470/`. The `spoon` section's header shows `https://github.com/octocat/Spoon-Knife.git` and `New thread`. Its table has the columns `Thread`, `Desired`, `Observed`, `Node`, `Human` and `Agent`, lists `browse: alpha` and `browse: beta`, and the observed column reads `running`. The sidebar's `Nodes` lists `verify-node`. Capture with `snapshot --filename browse-ui.md` and `screenshot --filename browse-ui.png`.
- **Filter.** Run `$V browser browse-ui-filter -- fill "role=searchbox[name=\"Filter threads\"]" "alpha"`. The sidebar's `Threads by project` list shows `browse: alpha` and hides `browse: beta`. The overview still lists both, because the filter covers only the sidebar. Capture `snapshot --filename browse-filter.md`, and again after 6 s as `browse-filter-after-poll.md`, which shows the filter survived the page's 5 s poll.
- **No match.** Run `$V browser browse-ui-none -- fill "#filter" "zzz"`. The sidebar hides the whole `spoon` folder, and `eval "() => document.getElementById('group-spoon').hidden"` prints `true`. Capture `snapshot --filename browse-no-match.md`.
- **Fold.** Clear the filter with `fill "#filter" ""`, then `click "#group-spoon > summary"`, and `eval "() => document.getElementById('group-spoon').open"` prints `false`. `fill "#filter" "beta"` opens it with only `browse: beta` shown, and clearing the filter folds it again. Capture `snapshot --filename browse-fold-filter.md` while it is open. Click the summary once more to unfold it.
- **Open from the list.** Run `$V browser browse-ui-pick -- click "role=link[name=\"browse: alpha\"]"`. The URL is `/threads/$TA`.
- **Errors.**
  - `$V cli browse-missing -- show th-000000000000 --json` exits 4 with stderr `{"error":"no thread th-000000000000","kind":"not-found","status":404}`.
  - `$V cli browse-bad -- show --json` exits 64 before any request, with stderr `{"error":"show takes 1 argument, got 0","kind":"invalid","status":null}`.
  - `$V cli browse-down -- threads --json --url http://127.0.0.1:1 --socks none` exits 2 with `kind` `unreachable` and `status` null.
- **Proof.** The recorded CLI steps, plus `browse-ui.md`, `browse-ui.png`, `browse-filter.md`, `browse-filter-after-poll.md`, `browse-no-match.md` and `browse-fold-filter.md`.

## Gotchas

- The overview and the sidebar both link each thread. The sidebar link's name adds its state and age, such as `running browse: alpha now`. The `role=link[name="<title>"]` selector above matched only the overview's link, but a looser match, such as Playwright's `getByRole` with that name, finds both. Scope it as `#overview >> role=link[name="…"]` if a click is ambiguous, from a page that shows the overview.
- The browser remembers folded projects in `localStorage`, across pages and later features. Leave every folder open at the end, or a later recipe finds the sidebar's threads hidden.
- The sidebar filter is client-side. It hides rows without a request, so prove it with a snapshot, not a network log.
- The CLI's `threads` leaves out deleted threads unless `--all` is given. The dashboard keeps them: archived and deleted threads fold together under each project's closed summary on the overview and in the sidebar, such as `1 archived, 2 deleted`.
- The plain-text output of `threads` is for people and may change. Assert on `--json`.
