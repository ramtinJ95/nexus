# Browse threads

A user finds threads and the state of their pylons from the terminal or the dashboard. The CLI lists threads, projects and nodes, and the dashboard groups threads by project, with a sidebar filter. Bad input gets a precise exit code instead of a guess.

## Sub-features

- `browse-threads` lists open threads with each pylon's desired and observed state.
- `browse-project` narrows the list to one project.
- `browse-meta` lists projects and nodes.
- `browse-ui` shows the overview table and the sidebar, and filters the sidebar by title.
- `browse-errors` maps an unknown thread to exit 4, bad arguments to exit 64, and an unreachable API to exit 2.

## How to get to it (user POV)

- Run `nexus threads [--project P] [--all]`, `nexus show <thread>`, `nexus projects` and `nexus nodes` in a terminal.
- Open the dashboard at `/`, type into `Filter threads` in the sidebar, and choose a thread's link to open its page.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Two threads exist and run: `browse: alpha` (`TA`) and `browse: beta` (`TB`), both started with `$V cli … start --project spoon --title … --json`.

- **List threads.** Run `$V cli browse-threads -- threads --json`. It holds rows for `TA` and `TB`. Each row has `desired` `running` and `pylon.actualState` `running`, on node `verify-node`.
- **One project.** Run `$V cli browse-project -- threads --project spoon --json`, which returns the same rows. Then run `$V cli browse-project-none -- threads --project nope --json`. Exit 0, and stdout is `[]`.
- **Projects and nodes.** `$V cli browse-projects -- projects --json` returns one project, `spoon`. `$V cli browse-nodes -- nodes --json` returns `verify-node` with `state` `online` and a recent `observedAt`.
- **Dashboard overview.** Run `$V browser browse-ui-open -- goto http://127.0.0.1:7470/`. The `spoon` section's table lists `browse: alpha` and `browse: beta`, and the observed column reads `running`. Capture with `snapshot --filename browse-ui.md` and `screenshot --filename browse-ui.png`.
- **Filter.** Run `$V browser browse-ui-filter -- fill "role=searchbox[name=\"Filter threads\"]" "alpha"`. The sidebar's `Threads by project` list shows `browse: alpha` and hides `browse: beta`. Capture `snapshot --filename browse-filter.md`.
- **Open from the list.** Run `$V browser browse-ui-pick -- click "role=link[name=\"browse: alpha\"]"`. The URL is `/threads/$TA`.
- **Errors.**
  - `$V cli browse-missing -- show th-000000000000 --json` exits 4 with `"kind": "not-found"`.
  - `$V cli browse-bad -- show --json` exits 64 with `"kind": "invalid"`.
  - `$V cli browse-down -- threads --json --url http://127.0.0.1:1 --socks none` exits 2 with `"kind": "unreachable"`.
- **Proof.** The recorded CLI steps, plus `browse-ui.md`, `browse-ui.png` and `browse-filter.md`.

## Gotchas

- The overview and the sidebar both name each thread, so `role=link[name="<title>"]` can match twice. Scope it as `#overview >> role=link[name="…"]` when a click is ambiguous.
- The sidebar filter is client-side. It hides rows without a request, so prove it with a snapshot, not a network log.
- Deleted threads appear only with `--all`, and archived ones sit under the project's closed-threads summary on the overview.
- The plain-text output of `threads` is for people and may change. Assert on `--json`.
