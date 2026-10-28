# The Mac nexus CLI

`nexus` runs on a Mac and drives the control plane's API: add projects, list threads, start one, message it, watch it, and archive or delete it. People use it at a shell. The Claude Code mod and the pi extension shell out to it, so this page is their contract. The code is [`src/cli/nexus.ts`](../src/cli/nexus.ts), and its transport is [`src/cli/transport.ts`](../src/cli/transport.ts). This page describes version 0.33.0, which `nexus --version` prints. Version 0.33.0 adds `usage backfill`, its route `/v1/usage/backfill`, `UsageBackfill`, `BackfillThread` and `BackfillPlanRow`, `UsageReport.backfill`, the backfill line of `usage`, `Thread.readingUsage`, and the desired phase `reading`, as [Usage backfill](#usage-backfill-0330) describes. Version 0.32.0 adds `usage`, the tokens the agents of every thread spent, its route `GET /v1/usage` and `UsageReport`, as [Token usage](#token-usage-0320) describes. Version 0.31.0 drops the attach settings 0.9.0 retired: a config file with `"ssh"` or `"attach"` fails like one with any other unknown key, and `attach` no longer names them or `NEXUS_ATTACH` on stderr, as [attach](#how-attach-connects) describes. Version 0.30.0 lands a review past the holds the person may waive when they press Land on the dashboard, which sends `{"head", "waive"}` to the land route, drops the field of `Review.waiver` that named the credential that confirmed it, with the dashboard's own routes and events of 0.28.0, and prints `waived by <node> at <commit>`, as [Reviews and landing](#reviews-and-landing-0180) describes. `land` sends no `waive`, so it is unchanged. `show` from a CLI of 0.28.0 or 0.29.0 fails on a review the dashboard waived, since it reads the credential's name, so upgrade the CLI with the control plane. Version 0.29.0 adds queued threads: `start --after`, which queues a thread to start once other threads' pull requests have merged, `start-queued`, `threads --queued`, what `threads`, `show`, `archive`, `unarchive` and `delete` print of a queued thread, `QueuedThread` and `Wait`, and the routes `GET /v1/queued`, `GET /v1/queued/<thread>` and `POST /v1/threads/<thread>/start`, as [Queued threads](#queued-threads-0290) describes. Version 0.28.0 added `Review.waiver`, the `waived by` lines of `show`, the event `review.waived`, and the routes the dashboard used to land a held review past the holds the person waived, as [Reviews and landing](#reviews-and-landing-0180) describes. Version 0.27.0 added `project edit --auto-review`, `Project.autoReview` and its column in `projects`, `Review.auto`, `Review.land.fromProject` and `Round.conflict`, has a landing's builder rebase a branch that conflicts with its base, and ends a held review whose pull request closed or whose builder was archived or deleted, as [Reviews and landing](#reviews-and-landing-0180) and [Project editing](#project-editing-0140) describe. Version 0.26.0 adds the review phases `merged`, `closed` and `cancelled`, which end a review without asking the person, and what `show` prints of them, as [Reviews and landing](#reviews-and-landing-0180) describes. Version 0.25.0 lets a project's default node be `auto`, makes `project add` without `--node` add such a project, and added `NodeSummary.overcommitted`, `NodeSummary.pylons` and what plain `nodes` prints of them, as [Placement](#placement-0250) describes. It also added `start --cpus`, `--memory` and `--disk`, `ThreadDetail.pylon.resources` and the size line of `show`, as [A thread's size](#a-threads-size-0250) describes, and raised the memory `project add` gives a project without `--memory` from 4 to 6 GiB. Version 0.24.0 caps a review at 5 rounds, gives a review whose rounds ran out the `needs human review` label and its `label`, shown by `show`, and replaces a finding's `severity` with `priority`, as [Reviews and landing](#reviews-and-landing-0180) describes. Version 0.23.0 added `Thread.setup` and the setup line of `show`, which say whether the pylon boots from a template or fresh, as [Templates at thread start](#templates-at-thread-start-0230) describes. Version 0.22.0 added `image build`, `image rollout`, `image rollback`, `image list` and `image current`, and their routes, as [Images](#images-0220) describes. Version 0.21.0 added the `limited` attention, `Thread.usageLimit`, `ClaudeConversation.usageLimit`, the `usageLimit` of a `notice` entry, the `usage-limit.continued` event, and the usage-limit lines of `threads`, `show` and `conversation`, as [Usage-limit stops](#usage-limit-stops-0210) describes. Version 0.20.1 made `send` to a Claude worker wait out the API's wait for the pylon, and a repeat of a send whose answer was lost report what it did, as [Claude conversations and steering](#claude-conversations-and-steering-0170) describes. Version 0.20.0 added `start --node auto`, `Thread.placement` and the placement line of `show`, and the CPUs and committed CPUs and disk of `NodeSummary.capacity`, as [Placement](#placement-0250) describes. Version 0.19.0 added `seen --last-reply-at`, made `watch` follow a Claude worker's transcript with `claude-reset` and `claude-entry` lines, and added the `pull-request` transcript entry. This page also lists [every thread field](#thread-fields) since then, `sessionTurnRunning` among them, though the fields are older. Version 0.18.0 added `review` and `land`, `ThreadDetail.review`, the `decision` attention and the `review.changed` event, as [Reviews and landing](#reviews-and-landing-0180) describes. Version 0.17.0 makes a Claude worker thread a conversation: `conversation` prints its Claude Code transcript and `send` types a message into its Claude session, as [Claude conversations and steering](#claude-conversations-and-steering-0170) describes. Version 0.16.1 added `--help` and `-h` after every command. Version 0.16.0 added `start --claude --model`, defaulted Claude to Opus 5.5, disabled commit and PR attribution, and preserved busy launches across Herdr readiness timeouts. `show` reports the worker model and launch diagnostic. Version 0.15.1 exposed stalled Claude worker launches, with pane diagnostics in `claudeWorker.message`. Version 0.15.0 added the resumable event stream and Claude Code thread workers. Version 0.14.0 added human-only project editing and a stale-grants warning. Version 0.13.0 added `deploy`, `release`, and waiting for fleet release health. Version 0.12.0 added PR-watch metadata and pull-request outputs to `show` (see [Pull requests](#pull-requests-0120)). Version 0.11.0 added Latest turn to dashboard Changes, `--turn` to `nexus changes` and `nexus diff`, and API `base=turn` with turn metadata and failures. Version 0.10.0 added shared `seenAt`, `lastReplyAt` and `attention` to thread rows and detail, and `seen <thread> [--unread]`, so clients no longer need their own seen stores. Version 0.9.0 made `attach` go through the control plane, over the attach route `GET /v1/threads/<thread>/attach`, a WebSocket, instead of ssh to the pylon's node, and retired its settings: `NEXUS_ATTACH`, and `"ssh"` and `"attach"` in the config file. An older control plane has no such route, and `attach` says to upgrade it. In 0.9.0, `Preview.failed` and `ready` also cover a preview whose port has no route into the pylon, and `ports` prints why a preview is not ready. Version 0.8.0 added `Session.id`, `Session.state` and `Session.message`, so a paused pylon lists the sessions its wake brings back and a session its last wake failed to bring back shows why, and `session close` now takes a session's ID, refuses a paused session, fails on a pane that is not open or that runs another session than the one listed there, and no longer tries again. Version 0.7.0 added scratch projects, whose `Project.repoUrl` is null, `project add --scratch` and `--secret`, and a null `Base.commit` where the base is the empty tree. Version 0.6.0 added `files`, `changes` and `diff`, their routes `GET /v1/threads/<thread>/files`, `GET /v1/threads/<thread>/changes` and `GET /v1/threads/<thread>/diff`, `Listing`, `Changes` and `Diff`, and the route `GET /v1/threads/<thread>/files/content`, which the CLI does not use. Version 0.5.0 added `session open`, `session close` and `attach`, the routes `POST /v1/threads/<thread>/sessions` and `DELETE /v1/threads/<thread>/sessions/<pane>`, `OpenedSession`, `Session.title`, `Preview.failed`, and the attach settings: `NEXUS_ATTACH`, and `"ssh"` and `"attach"` in the config file. Version 0.4.0 added `project add` and its route, `POST /v1/projects`. Version 0.3.0 added `unpreview` and its route, `DELETE /v1/threads/<thread>/previews/<port>`. Version 0.2.0 added `ports`, `preview`, `Preview.url`, `ThreadDetail.ports` and the `ports` of a watch `state`.

This is a different program from the `nexus` inside a pylon ([`images/pylon/nexus`](../images/pylon/nexus)), which talks to its own node's probe.

## Install

From the root of a checkout that has `node_modules`, with Node 26 or newer on `PATH`:

```sh
ln -sf "$PWD/deploy/mac/nexus" ~/.local/bin/nexus
```

The shim follows its symlink back to the checkout and runs `node src/cli/nexus.ts`.

## Where it connects

The Mac reaches the home tailnet only through ts-home's userspace tailscaled, which serves a SOCKS5 proxy on `localhost:1055`. Every request opens a SOCKS5 CONNECT to the control plane and sends HTTP through it. The proxy resolves the name, because only it knows MagicDNS. The API allows this Mac by its tailnet node, so the CLI sends no token.

Two settings choose the endpoint. For each one, the first of these that is set wins:

| Setting | Flag | Environment | `~/.config/nexus/cli.json` | Default |
|---|---|---|---|---|
| Control plane URL, `http://` only | `--url` | `NEXUS_URL` | `"url"` | `http://rj-firebat.tailc817d3.ts.net:7470` |
| SOCKS5 proxy, `HOST:PORT`, or `none` to connect directly | `--socks` | `NEXUS_SOCKS` | `"socks"` | `localhost:1055` |

An empty environment variable counts as unset. The config file is a JSON object with only those two optional keys. Any other key fails the command with exit code 64.

### How `attach` connects

`attach` reaches the pylon's Herdr session through the control plane, over the same URL and proxy as every other command, so this Mac needs no ssh access to the node. Whoever may call the API may attach. That adds no power, because the same caller can already have an agent run any command in the pylon.

Before 0.9.0, `attach` ran ssh to the pylon's node, chosen by `"ssh"` in the config file, or ran the command in `NEXUS_ATTACH` or the config's `"attach"`. Through 0.30.0 a config file could still hold them, and `attach` named those it found on stderr. Since 0.31.0 they are unknown keys, so a config file that has one fails every command with exit code 64, and `NEXUS_ATTACH` is not read.

### The attach route

`GET /v1/threads/<thread>/attach?cols=C&rows=R&term=T` is a WebSocket, RFC 6455, with no subprotocol and no extensions. It is the contract a browser terminal on the dashboard can use too. `src/attach-wire.ts` is the one definition both ends of the CLI's attach use.

- `cols` and `rows` are the terminal's size, whole numbers from 1 to 9999, and both are required, because Herdr refuses a terminal of zero size. `term` is the terminal type, which matches `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`, and is `xterm-256color` when it is left out. The CLI sends `$TERM` when it matches, and `xterm-256color` otherwise.
- The route admits the caller as every route does. An `Origin` header must be absent, as it is from the CLI, or exactly `http://<Host>`, the dashboard's own origin. A browser sends Origin with every WebSocket, and previews are served under the API's hostname on other ports, so a preview's page could otherwise open a terminal.
- Every refusal comes before the 101, as an ordinary reply with the API's `{"error": string}` body: 403 for a caller, Host or Origin it does not allow, 400 for a bad query, 404 for an unknown thread, 409 for an archived or deleted thread, and 503 when the node has no probe or 16 streams are open, which terminals share with the event streams.

After the 101, a binary message carries terminal bytes, both ways, and a text message carries one JSON object, whose `type` says what it is. Either end ignores a type it does not know.

| From | Message | Meaning |
|---|---|---|
| Client | binary | Keys for the terminal. Keys before `attached` are dropped |
| Client | `{"type": "resize", "cols": C, "rows": R}` | The terminal's new size. Before `attached`, it replaces the size the terminal opens with |
| Client | close | Detach. The terminal hangs up, Herdr's client detaches, and the session stays |
| Server | `{"type": "waiting", "pylon": ActualState}` | The pylon does not run yet. Sent on each change of its state |
| Server | `{"type": "attached"}` | Once. The terminal's output follows |
| Server | binary | What Herdr writes to the terminal |
| Server | `{"type": "exit", "code": number}` | Herdr's client exited. 0 is Herdr's own detach |
| Server | `{"type": "error", "kind": "conflict" \| "failed" \| "unreachable", "message": string}` | Why the attach ended otherwise |

The server sends exactly one `exit` or `error`, then closes with 1000, or 1001 when the control plane is stopping. A close without either is a dropped link. The route wakes the pylon as a human's request does, records human activity on each try, and waits up to 120 seconds for the pylon to run. The server pings every 15 seconds and drops a client that did not answer the last ping, and the pings keep the CLI's 30-second idle timeout from firing while the terminal is quiet.

## Commands

Every command takes `--json`, `--url` and `--socks`. `--help` or `-h` after a command prints that command's lines of `nexus --help` and exits 0 without sending a request. `<thread>` is a thread ID such as `th-0123456789ab`.

With `--json`, a command prints one JSON value on stdout, pretty-printed. The value is the API's reply, apart from the exceptions noted in the table. Without `--json`, output is plain text for people. Its format is not part of this contract.

| Command | Route | `--json` prints |
|---|---|---|
| `review <thread> [--pr N] [--rounds N] [--land]` | `POST /v1/threads/<thread>/review` with `{"pr"?: number, "rounds"?: number, "land"?: true}`, which answers 201 | `Review`, the review it started |
| `land <thread>` | `POST /v1/threads/<thread>/land` with `{}` | `Review`, moved back to its check |
| `deploy <commit|main> [--wait]` | `PUT /v1/release` with `{"commit": string}`, then `GET /v1/release` while waiting | `ReleaseView`, described below |
| `release` | `GET /v1/release` | `ReleaseView` |
| `image build [--wait]` | `POST /v1/images/build` with `{}`, then `GET /v1/images` while waiting | `ImageOperation`, the build, or `ImagesView` with `--wait` |
| `image rollout <image> [--wait]` | `POST /v1/images/rollout` with `{"image": string}`, then `GET /v1/images` while waiting | `ImageOperation`, the rollout, or `ImagesView` with `--wait` |
| `image rollback [--wait]` | `POST /v1/images/rollback` with `{}`, then `GET /v1/images` while waiting | `ImageOperation`, the rollout back to the previous image, or `ImagesView` with `--wait` |
| `image list` | `GET /v1/images` | `ImagesView` |
| `image current` | `GET /v1/images/current` | `{ current: ImageEntry \| null, previous: ImageEntry \| null }` |
| `threads [--project P] [--all]` | `GET /v1/threads[?project=P]`, and `GET /v1/queued[?project=P]` for the queued threads its text lists after the others | `ThreadRow[]`: each `Thread` with `desired` and `pylon: { node, actualState, failed }`, as in `ThreadDetail`. A thread whose harness or session turn runs carries `workingSince`, the earliest known start of those turns in Unix milliseconds, unless no start is known. Deleted threads are left out unless `--all` is given. Queued threads are never in it |
| `threads --queued [--project P] [--all]` | `GET /v1/queued[?project=P]` | `QueuedThread[]`, the threads that have not started. Cancelled and deleted ones are left out unless `--all` is given |
| `show <thread>` | `GET /v1/threads/<thread>`, then `GET /v1/queued/<thread>` when that answers 404 or 409 | `ThreadDetail`. Its `desired` is what the planner wants of the pylon now: `running`, `paused` or `deleted`. Its `attach` is the command that attaches to the pylon's Herdr sessions from a shell in the pylon. For a thread that has not started, `QueuedThread` |
| `ports <thread>` | `GET /v1/threads/<thread>` | `ListeningPort[] \| null`, the detail's `ports` |
| `preview <thread> <port> [--wait]` | `POST /v1/threads/<thread>/previews` with `{"port": number}`, then with `--wait` polls `GET /v1/threads/<thread>` | `Preview`, the port's preview |
| `unpreview <thread> <port>` | `DELETE /v1/threads/<thread>/previews/<port>` with `{}` and its `content-length`, which answers 204. Node's `http` module frames a DELETE's body only with an explicit length. While the pylon is not running, it tries again once a second | `null` |
| `files <thread> [path]` | `GET /v1/threads/<thread>/files?path=<path>`. While the pylon is not running, it tries again once a second | `Listing`, the directory's entries |
| `changes <thread> [--uncommitted | --turn]` | `GET /v1/threads/<thread>/changes?base=start`, or `base=head` with `--uncommitted`, or `base=turn` with `--turn`. While the pylon is not running, it tries again once a second | `Changes` |
| `diff <thread> [path...] [--uncommitted | --turn]` | `GET /v1/threads/<thread>/diff?base=start&path=<path>...`, or `base=head` with `--uncommitted`, or `base=turn` with `--turn`. While the pylon is not running, it tries again once a second | `Diff` |
| `conversation <thread>` | `GET /v1/threads/<thread>/conversation` | `ConversationView`, or a `ClaudeConversation` for a Claude worker thread |
| `session open <thread> [--harness claude-code\|pi\|shell] [--title T]` | `POST /v1/threads/<thread>/sessions` with `{"harness"?: string, "title"?: string}`, which answers 201. While the pylon is not running, it tries again once a second | `OpenedSession`, the session it opened |
| `session close <thread> <pane\|id>` | `DELETE /v1/threads/<thread>/sessions/<id>` with `{}`, which answers 204. It does not try again | `null` |
| `attach <thread>` | `GET /v1/threads/<thread>/attach`, a WebSocket, as [the attach route](#the-attach-route) describes | Nothing. The terminal is the session's |
| `start --project P [--title T] [--message M] [--node N\|auto] [--branch B] [--commit C] [--cpus n] [--memory GiB] [--disk GiB]` | `POST /v1/threads`, then `POST .../messages` when `--message` is given | `Thread`, the thread that was started, with its `placement` |
| `start ... --after THREAD[,THREAD...]` | One `POST /v1/threads` with `"after": string[]`, and `"message": string` when `--message` is given, which answers 201 | `QueuedThread`, the thread that was queued |
| `start-queued <thread>` | `POST /v1/threads/<thread>/start` with no body, which answers 201 | `Thread`, the thread that was started |
| `send <thread> <text...> [--steer] [--request-id ID]` | `POST /v1/threads/<thread>/messages`. For a Claude worker thread, while the pylon is not running, it tries again once a second | `{ "submission": number }`, or `{ "claude": ClaudeSent }` for a Claude worker thread |
| `watch <thread> [--interval MS]` | Follows `GET /v1/threads/<thread>/events`, or `GET /v1/threads/<thread>/claude/events` for a Claude worker thread, and polls `GET /v1/threads/<thread>` | A stream of JSON lines, described below |
| `abort <thread>` | `POST /v1/threads/<thread>/abort` | `null` |
| `retry <thread>` | `POST /v1/threads/<thread>/retry` | `null` |
| `retry-pylon <thread>` | `POST /v1/threads/<thread>/pylon/retry` | `null` |
| `seen <thread> [--unread \| --last-reply-at MS]` | `POST /v1/threads/<thread>/seen` with `{}`, or `{"lastReplyAt": MS}` with `--last-reply-at`, or `/unseen` with `--unread` | `null` |
| `wake <thread>` | `POST /v1/threads/<thread>/activity` with `{"kind":"human"}` | `null` |
| `archive <thread>` | `POST /v1/threads/<thread>/archive` | `Thread`, or `QueuedThread` with status `archived` for a thread that has not started, which cancels it |
| `unarchive <thread>` | `POST /v1/threads/<thread>/unarchive` | `Thread`, or `QueuedThread` with status `queued` for a cancelled one, which queues it again |
| `delete <thread>` | `DELETE /v1/threads/<thread>` | `Thread`, with status `deleted`, or `QueuedThread` with status `deleted` |
| `projects` | `GET /v1/projects` | `Project[]`. A scratch project's `repoUrl` is null |
| `project add <id> (<repo-url> \| --scratch) [--node N\|auto] [--branch B] [--cpus n] [--memory GiB] [--disk GiB] [--allow-host HOST]... [--login claude\|chatgpt]... [--secret NAME:HOST[,HOST]...]...` | `POST /v1/projects` | `Project`, the project that was added |
| `nodes` | `GET /v1/nodes` | `NodeSummary[]` |
| `usage [--since today\|7d\|30d\|all\|DATE] [--project P] [--by model\|project\|kind\|role\|day]` | `GET /v1/usage?since=<since>[&project=P][&by=B]`, with `since=7d` unless `--since` is given | `UsageReport` |
| `usage backfill [--dry-run \| --stop]` | `POST /v1/usage/backfill`, or `GET` with `--dry-run`, or `DELETE` with `--stop` | `UsageBackfill`, or `{ backfill: UsageBackfill, plan: BackfillPlanRow[] }` with `--dry-run` |

These commands need more explanation:

- `start` without `--title` takes the title from the first non-empty line of `--message`, trimmed. A line longer than 80 characters keeps its first 80 and gets `...` appended, so such a title is 83 characters. It needs at least one of the two. If the thread starts but its first message fails, the command fails with the message's exit code, and the error names the thread that was started.
- `start --commit` on a scratch project fails with exit code 64, because its repository has no commit to check out. `--branch` names the empty repository's first branch instead.
- `send` joins its words with single spaces. By default the message is a follow-up, so a busy run takes it after its current turn. With `--steer`, the message joins the current run after its current tool round. The API treats a second send with the same `--request-id` as the same message. A caller that retries a send should pass its own request ID, such as `msg:<uuid>`. Without one, each run mints a new ID. A Claude worker thread's message goes to Claude, never to the Nexus agent, whatever the mode.
- `project add` adds a project whose threads clone `<repo-url>` and boot on node `N`, or with `--node auto` or no `--node` on the node where each pylon fits best, unless `start --node` picks another, as [Placement](#placement-0250) describes. With `--scratch` instead of a URL, the project has no repository: each thread's pylon starts from `git init` on the branch, nothing is fetched, and nothing in the pylon is kept once the thread is deleted unless its agent pushed it somewhere. It sends this `Project`: `repoUrl` is `<repo-url>`, or null with `--scratch`. `defaultBranch` is `--branch`, or `main`. `defaultNode` is `--node`, or `auto`. `resources` is `{ cpus, memoryGiB, diskGiB }` from `--cpus`, `--memory` and `--disk`, or 2, 6 and 10. The projects in use run at 6 GiB, and coding threads were measured to peak at about 1.4 GiB in the guest. `allowedHosts` holds each `--allow-host`, `logins` each `--login`, and `secrets` each `--secret`, in the order given. `preSetup` is null, which only the API can set. Without `--json` it prints `Added project <id> (<repo-url>) on <node>`, or `Added scratch project <id> on <node>`, where `<node>` may be `auto`. Exactly one of `<repo-url>` and `--scratch` is required. Without one, or with both, the command fails with exit code 64 before it sends any request, so a forgotten URL never makes a scratch project. `nexus nodes` lists the nodes. A project that exists fails with exit code 5. A node the control plane does not know, an ID that is not lowercase letters, digits and hyphens starting with a letter or digit, up to 63 characters, an `https://` URL that does not parse, or a login other than `claude` or `chatgpt` fails with exit code 64. The API accepts any other non-empty `<repo-url>`, such as an SSH one. Use `project edit` to change settings; IDs and repository URLs cannot change. Projects cannot be removed from the CLI.
- `--secret NAME:HOST[,HOST]` grants the secret `NAME` to those hosts, such as `--secret GH_TOKEN:api.github.com,github.com`, which lets the project's agents create GitHub repositories with `gh` and push to them. The value is never sent: it lives in each node's `/etc/nexus/secrets.env`, as [deploy/README.md](../deploy/README.md) describes, and a pylon on a node that lacks it fails to boot. The name is upper-case letters, digits and underscores, not starting with a digit, and each host a lower-case hostname with a dot. Anything else, such as `GH_TOKEN=<token>` pasted by mistake, fails with exit code 64 before any request, and the error does not repeat it. Each host joins the pylon's allowlist.
- `session open` opens a session in the pylon: a Herdr workspace in the checkout, `/home/user/workspace/repo`, labelled with the title, with the harness's agent in it. The harness is `claude-code` by default, and the title is the harness's name by default, at most 80 characters. The command returns once the agent is ready or waits for its human, such as Claude Code at its login or trust screen, so a session that needs `/login` opens and waits for it. Starting an agent can take most of a minute, so the command waits up to 120 seconds for the reply, rather than the usual 30. Opening is human activity, so a paused pylon is woken, and the command tries again once a second until the pylon runs, failing with exit code 1 after 120 seconds. An archived or deleted thread fails with exit code 5, a harness other than the three with exit code 64, and a node the control plane cannot reach with exit code 1. The session is listed in the thread's `sessions` within moments, because the node reads its sessions again at once. Without `--json` it prints `Opened <harness> session "<title>" in pane <pane> of <thread>.` and how to attach.
- `session close` closes a session by its `id` from the thread's `sessions`, which is its pane, `herdrPane`, for every session in one. Closing a pane ends its agent. A `failed` session in no pane has an `id` of the form `failed-<hash>`, and closing it drops it from the pylon, so no wake tries it again. A `paused` session fails with exit code 5 without waking the pylon: it comes back when the pylon wakes, or when `nexus unarchive` wakes an archived thread's, and can be closed once it runs. A pane that is not open fails with exit code 4, because a wake can move a session to another pane, so a pane from before it may name no session or another one: read `sessions` again. So does a pane that runs another session than the one `sessions` last listed in it, which is left open. A pylon that is not running fails with exit code 5, and the request wakes it, so ask again once it runs. The command never tries again on its own. Without `--json` it prints `Closed session <id> of <thread>.`
- `attach` gives this terminal to the pylon's Herdr session, `herdr --session nexus`, in which every session is a workspace, until you detach from Herdr. It needs a terminal on stdin and stdout, and fails with exit code 64 without one. It goes through the control plane, as [How `attach` connects](#how-attach-connects) describes. Asking wakes a paused pylon, and until it runs, `attach` prints one line on stderr for each state it passes, such as `nexus: waiting for the pylon of <thread>, which is paused`. Ctrl-C still quits then, because the terminal goes raw only once Herdr starts. While attached, resizing the window resizes Herdr. The terminal goes back to the mode it was in on every way out: Herdr's detach, an error, a dropped connection, and SIGTERM or SIGHUP, such as a closed window, after which `attach` exits 143 or 129. It exits 0 when Herdr's client exits 0, which is a detach. It fails with exit code 5 for an archived or deleted thread, before or during the attach, with exit code 1 for a failed pylon, a pylon that does not run within 120 seconds, Herdr exiting with another code, or a control plane that has no attach route, whose message says to upgrade it, and with exit code 2 when the connection to the control plane or the pylon drops, or the control plane stops. Herdr keeps the session through all of those, so run `attach` again. If no Herdr server runs yet, the pylon starts one as `session open` does. While a terminal stays attached, the pylon counts a human as present, so the 20 minutes without a human that pause a pylon do not run out. Detach from Herdr, or close the terminal, to let the pylon pause. An archived thread's pylon pauses all the same, which ends the terminal with exit code 5.
- To log Claude Code in, run `nexus session open <thread>`, then `nexus attach <thread>`, pick the session's workspace in Herdr, and type `/login` in Claude Code. The project's threads need `claude` among its `logins`, which a human can set with `nexus project edit <id> --login claude` (list replacement; include any other desired logins). Pick the device-code or paste login, because a browser callback cannot reach the pylon. The login lives on the pylon's disk, so it survives pauses but not the thread. Every Claude Code session starts with a session ID of its own, so after an archive and an unarchive it comes back with `claude --resume <id>` and its conversation, whether or not it was logged in when it opened.
- `retry` runs a conversation's parked tasks again. `retry-pylon` clears a failed pylon so that the planner boots it again.
- `seen` records when a person looked at the latest reply, shared by all clients. `--last-reply-at MS` marks only up to the reply whose `lastReplyAt` is `MS`, the one the client showed, so a reply that lands between the client's read and `seen` stays unread. It never lowers an existing mark. `MS` is a whole number of Unix milliseconds, and anything else, or `--last-reply-at` with `--unread`, fails with exit code 64. `--unread` sets `seenAt` to `lastReplyAt - 1`, or null if there is no reply. All of them work on archived threads, never record human activity and never wake a pylon.
- `wake` records human activity, so a paused pylon is wanted running.
- `ports` lists the TCP ports that something in the pylon listens on and that a preview can reach, as the pylon's node last reported them. The node reads them every 10 seconds, so a server the agent just started shows within about that long. A port is listed whether or not it has a preview, and whatever started it: a declared service, an ad hoc one, or a process the agent ran itself. Nexus's own listeners, sshd on port 22 and the preview relay on ports 700 to 799, are left out. "A preview can reach" means bound to 127.0.0.1, 0.0.0.0, `::` or `::1`, or to the IPv4-mapped form of 127.0.0.1 or 0.0.0.0. Gondolin's ingress always connects over IPv4 to 127.0.0.1 and offers no way to choose another address, so every preview goes through a relay in the pylon, which listens on one of its own ports and connects to the server's port on 127.0.0.1, or on `::1` when nothing listens there. A server bound only to `::1`, as Vite and other Node servers that bind `localhost` are on Node 17 and later, is therefore listed and previewed like any other. The relay never holds the server's port, so a server may bind it again, or move it to another address, while its preview stays published. A preview is routed to its relay port only once the relay confirms that it listens there for that server's port, so a relay port that something else in the pylon holds, which only root can, is never routed, and its preview is not ready, with the relay's reason in `failed`. A pylon previews at most 100 ports at once, one per relay port, and `preview` refuses the 101st until another is unpublished. A server bound to another loopback address such as 127.0.0.2, or to any other address, is not listed and cannot be previewed.
- `preview` publishes a port as a preview, as `nexus preview <port>` does inside the pylon, and prints the port's `Preview`. The port need not listen yet. Asking again for the same port prints the same preview. A port that a declared or ad hoc service owns is previewed under that service, and a service without a preview is refused with exit code 1. Any other port is previewed as the service `port-<port>`, except Nexus's own, which is refused with exit code 64. A declared or ad hoc service's preview stays published for the thread's life, and a linked port's until `unpreview`. Either is open to every device on the home tailnet, and keeps its URL across pauses. After a wake, a process the agent started by hand must be started again before the URL answers. Previewing is human activity, so a paused pylon is woken, but the request itself needs the pylon running and fails with exit code 5 until it is. An archived or deleted thread fails with exit code 5, and a node the control plane cannot reach fails with exit code 1.
- `preview` prints the URL at once, but tailscale serves it only after the control plane's next pass publishes it, usually within seconds. With `--wait` the command polls once a second until the port's entry in `ports` has a preview whose `ready` is true, and prints that preview. Then the port listens in the pylon, its service, if the node reports one, is ready, and the node publishes and has warmed the URL. It fails with exit code 1 after 120 seconds.
- A preview whose service the pylon's node reports starting, stopped or failed is not ready, though the node may still publish its URL, which then answers 502. So is one whose port the node reports without a route into the pylon, such as a relay port the relay cannot listen on, whose URL answers 404. A failed or unrouted one's `failed` says why, and the text of `show`, `ports` and `preview` says so too, as does the message of a `--wait` that runs out. `--wait` keeps polling, because a service that starts, or one restarted in the pylon, makes the preview ready, and so does a relay port that frees up.
- `unpreview` stops publishing a port that `preview` published, as `nexus unpreview <port>` does inside the pylon. It unlinks the port in the pylon and then drops its preview, so once it exits 0 the thread's `previews` leave it out, the port's entry in `ports` has `preview: null`, and the next `state` of a watch shows that. The pylon keeps the port unlinked across pauses, wakes and restarts of the probe or the control plane, and `preview` publishes it again, possibly on another https port. A port with no linked preview succeeds, so the command is safe to repeat. A port whose preview a declared or ad hoc service owns is refused with exit code 1: the API answers 422, and its `error` is the pylon's reason alone, which names the service, because only the service's declaration can drop that preview. So is a port whose name `port-<port>` a service holds. Nexus's own ports and anything that is not a port from 1 to 65535 fail with exit code 64. An archived or deleted thread fails with exit code 5, and a node the control plane cannot reach fails with exit code 1.
- `files`, `changes` and `diff` read the pylon's checkout, `/home/user/workspace/repo`, as the Files and Changes views of a client do. Paths are relative to the checkout, and one that leaves it, through `..` or a symlink, fails with exit code 64, so a client never shows the pylon's Claude Code and pi logins by mistake. The reads run in the pylon, so this check is no boundary against the pylon itself, whose agent can read those files anyway and could swap a checked path for a symlink. `files` lists a directory, the checkout itself by default, sorted by name, with each file's size, at most 2000 entries. A path that does not exist fails with exit code 4.
- `changes` lists the files that differ from the commit the pylon booted at, so the agent's commits show as well as its uncommitted work. With `--uncommitted` they differ from HEAD instead. All three scopes compare the working tree, untracked files included and ignored ones left out, without touching the pylon's own git index. A rename shows as one, with its `oldPath`. A binary file's `additions` and `deletions` are null. At most 3000 files are listed, and `truncated` says whether there were more. The pylon records what it booted at as `refs/nexus/base` in the checkout, on its first boot. A scratch project's pylon boots an empty repository, which has no commit, so it records the empty tree: every file shows as added, before the agent's first commit and after it, and `base.commit` is null. Before the first commit, `--uncommitted` compares with the empty tree too, with a null `base.commit`. A pylon that booted before Nexus recorded it has none, so `changes` without `--uncommitted` or `--turn` fails with exit code 1, the API's 422, and the message says to ask for the changes since HEAD instead.
- `--turn` compares with a snapshot taken before the latest autonomous agent reply's first model request, before any tools run. In a Claude worker thread it is taken before Claude Code acts on the latest prompt of any Claude Code session in the pylon. It includes that reply's commits and uncommitted work, excluding work already present at its start. A reply includes all its tool rounds and steering messages; a queued follow-up starts another turn. `--turn` and `--uncommitted` together fail with exit code 64. Work changed by a person or background process after the snapshot also counts: this is a tree comparison, not authorship tracking. Interactive pi sessions do not create these snapshots.
- The turn snapshot is a parentless hidden commit at `refs/nexus/turn`, made through a temporary index, including non-ignored untracked files. It changes neither HEAD, a branch nor the real index, works before the first ordinary commit, and survives pause and wake on the pylon's disk. `base.commit` for `turn` is the snapshot commit, not HEAD, and is non-null even for an empty tree. The snapshot records the reply's first input submission ID; reads check it against the active reply or the last attempted reply recorded in the durable `nexus.turn-snapshot` conversation document so a lost connection cannot leave a previous turn masquerading as the latest one. A Claude Code turn's snapshot records its session ID and the stamp of its `session.turn-started`, and a Claude worker thread's reads check it against the newest turn start the control plane recorded for the thread, so a turn whose snapshot failed, or a pylon whose image predates Claude turn snapshots, refuses the same way. An older pylon, a turn not yet captured, or a failed snapshot makes both commands fail with exit code 1 (API 422, `no-base` internally), with a message explaining that no latest-turn snapshot is available and suggesting another turn or HEAD. Snapshot failures are logged and do not fail the reply. Capturing never requests a wake; it waits for the pylon already wanted by the turn. The conversation document records the attempt before capture, so later generation tasks and recovery do not snapshot again after tools might have run.
- `diff` prints the unified diff from the same base, of the whole tree or of the paths given. Each path is literal, never a glob. A renamed file needs both its old and its new path, or it shows as added. The diff stops at 4 MiB, and `truncated` says whether it did. Reading a large tree can take the pylon a while, so these commands wait up to 120 seconds for the reply, rather than the usual 30.
- Like `preview`, reading the checkout is human activity, so the first try wakes a paused pylon, and the command tries again once a second until the pylon runs, failing with exit code 1 after 120 seconds. An archived or deleted thread fails with exit code 5. A read the pylon does not finish within 90 seconds fails with exit code 1, the API's 504. So does one asked for while 32 reads are open on the control plane, the API's 503, because a read that passed its deadline stays open until the pylon's process ends. Paths too long for one request, about 8 KiB once URL-encoded, fail with exit code 64.
- `GET /v1/threads/<thread>/files/content?path=<path>` serves a file's bytes, at most 10 MiB, for a client to show. A larger file is refused with 413, and a directory with 400. PNG, JPEG, GIF and WebP files are served as images. Anything else is served as `text/plain; charset=utf-8` when it is UTF-8 without a NUL byte, and as `application/octet-stream` otherwise, with `x-content-type-options: nosniff` and a sandboxing `content-security-policy`, so a repository's HTML or SVG never runs as a page of the API's origin, which the dashboard shares.
- `unpreview` needs the pylon running, because the pylon holds the link. Unpublishing is human activity, so the first try wakes a paused pylon, and the command tries again once a second until the pylon runs. It fails with exit code 1 after 120 seconds.
- Once `unpreview` exits 0, nothing reaches the app through the URL: the node's preview gateway has stopped routing it and answers 404 `no preview is published on <host>` itself, to a browser too. Tailscale stops serving the URL, after which a new connection to it is refused, only once the control plane's next pass publishes the previews without it, usually within a few seconds. The command does not wait for that pass.

The shapes are TypeScript types. `Thread`, `Session` and `Preview` are in [`src/control/registry.ts`](../src/control/registry.ts). `Listing`, `Changes` and `Diff` are in [`src/checkout-files.ts`](../src/checkout-files.ts). `ThreadDetail`, `ListeningPort`, `OpenedSession` and `NodeSummary` are in [`src/control/api.ts`](../src/control/api.ts). `Project` is in [`src/project.ts`](../src/project.ts). `ConversationView`, `EntryRecord`, `LiveState` and `InboxState` come from `@earendil-works/pi-durable`. `ClaudeConversation` and `ClaudeEntry` are in [`src/claude-transcript.ts`](../src/claude-transcript.ts), and `ClaudeSent` is in [`src/control/registry.ts`](../src/control/registry.ts). `UsageReport`, `UsageBackfill`, `BackfillThread` and `BackfillPlanRow` are in [`src/control/usage.ts`](../src/control/usage.ts). Times in `Thread` are Unix milliseconds, and the observation times are ISO strings. A consumer must ignore fields it does not know.

### Thread fields

`Thread` carries these fields. So does each `ThreadRow`, at its top level, and `ThreadDetail.thread`. A field marked optional is left out rather than sent as false or null. Times are Unix milliseconds.

| Field | Type | Meaning |
|---|---|---|
| `id`, `title`, `project`, `pylonId` | `string` | The thread, its title, its project and its pylon |
| `status` | `"active" \| "idle" \| "archived" \| "deleted"` | The thread's status |
| `conversationId` | `string \| null` | The Nexus agent's conversation. Null for a thread without one, such as a Claude worker thread |
| `startedBy` | `string` | The tailnet node ID of the caller that started the thread, or `nexus-review` or `nexus-check` for a reviewer or check thread that the review loop started |
| `createdAt` | `number` | When the thread started |
| `agentTurnRunning` | `boolean` | A turn of the Nexus agent runs |
| `sessionTurnRunning` | optional `true` | A turn of a session in the pylon runs, as its hooks report, such as the Claude worker's. A Claude worker thread works while this is present |
| `sessionActiveUntil` | optional `number` | When that turn's working lease runs out without another report. Present with `sessionTurnRunning` |
| `sessionWaiting` | optional `true` | A session in the pylon waits for input, such as a permission prompt |
| `sessionWaitingMessage` | optional `string` | What the latest waiting session's report said, such as "A background command was still running after 2 hours" |
| `working` | `boolean` | A turn of the Nexus agent or of a session in the pylon runs: `agentTurnRunning` or `sessionTurnRunning`. `threads` prints `working` for it, and `show` `agent working` |
| `workingSince` | optional `number` | The earliest known start of the running turns, as `threads` describes |
| `lastAgentActivityAt`, `lastHumanActivityAt` | `number` | The newest agent and human activity, which decide when the pylon pauses |
| `seenAt`, `lastReplyAt` | `number \| null` | The shared seen marker and the latest reply, as the next section describes |
| `placement` | optional `Placement` | Which node the pylon boots on and why, as [Placement](#placement-0250) describes. Left out for a thread started before 0.20.0 |
| `usageLimit` | optional `{ stoppedAt: number, resetsAt: number \| null }` | The Claude worker's session stopped on its usage limit at `stoppedAt`, and nothing has run since. `resetsAt` is when the limit resets, null when Claude Code did not say. [Usage-limit stops](#usage-limit-stops-0210) describes it |
| `setup` | optional `ThreadSetup` | Whether the pylon boots from a template or fresh, and why, as [Templates at thread start](#templates-at-thread-start-0230) describes. Left out for a thread started before 0.23.0 |
| `readingUsage` | optional `true` | The usage backfill reads this archived thread's pylon now, so its `desired` is `reading`, as [Usage backfill](#usage-backfill-0330) describes |
| `attention`, `desired`, `pylon` | | In `ThreadRow` only. `ThreadDetail` has them at its top level, beside `thread` |

`ThreadDetail` has `thread`, `attention`, `seenAt`, `lastReplyAt`, `desired`, `pylon` (`id`, `node`, `actualState`, `failed`, `observedAt`, `grantsOutdated` and `retryRefused`, why a retry cannot help or null), `sessions`, `previews`, `ports`, `outputs`, `prWatch`, `pullRequests`, `review`, `attach`, `agent` (`{ parkedTasks }`, or null for a thread without a Nexus agent conversation), and for a Claude worker thread `claudeWorker` (`model`, `state`, optional `message`).

### Attention and shared seen state

`ThreadRow` has `seenAt`, `lastReplyAt` and `attention` at the top level. `ThreadDetail` has the same three fields at the top level; its `thread` also has the two stored timestamps. The timestamps are Unix milliseconds or null. `lastReplyAt` is when the latest agent turn ended, not each streamed chunk. `seenAt` is when a person last marked the conversation seen, from any client. Existing threads start with both timestamps null at migration; their next observed turn end supplies a reply timestamp. A turn found ended on control-plane recovery is dated at recovery, since its exact end time is not known.

`attention` is the first matching condition, in this order:

1. `"failed"`: the pylon or Claude worker launch failed.
2. `"decision"`: the thread's review ended for the person, whose reasons `review.phase.reasons` lists.
3. `"parked"`: tasks hit the restart limit and need `retry`, whether any client watches the thread or not.
4. `"limited"`: the Claude worker's session stopped on its usage limit, so `usageLimit` is present. Seen does not clear it; the next turn does.
5. `"reply"`: `lastReplyAt` is non-null and later than `seenAt`, or `seenAt` is null.
6. `"working"`: a harness or reported session turn is running.
7. `"waiting"`: a session is waiting for input.
8. `null`.

It is the value the thread's latest `attention.changed` event carries. An unread reply outranks working, so a client cancelling a pending reply notification on a follow-up must also check `working`. Reading `threads` or `show` does not mark anything seen; clients call `seen` when they show the conversation. `GET /v1/threads?deleted=false` leaves deleted threads out, as the dashboard reads the list; without it the list has them, which `threads --all` prints.

`POST /v1/threads/<thread>/seen` accepts an optional JSON body `{ "lastReplyAt": number | null }`. A client rendering asynchronously sends the reply timestamp captured with the conversation it actually rendered, not a newer timestamp from attention polling. The mark cannot advance beyond that timestamp; null marks nothing. A stale mark does not lower an existing seen marker. `nexus seen --last-reply-at MS` sends the field. Omitting it, as `nexus seen` without that flag does, marks the latest reply seen at request time. `/unseen` still marks the latest reply unread.

Reply timestamps also serve as reply identities: each recorded reply is at least one millisecond greater than both the preceding reply and the current seen marker. This preserves strict unread ordering for events in the same millisecond or after a clock correction. A client must use the returned timestamp, not reconstruct it from its own clock. Reply notifications compare this identity and working transitions as well as attention, so a follow-up can notify even while attention stays `"reply"`.

The sessions, previews and ports in `ThreadDetail` have these shapes:

```ts
type Session = {
  pylon: string;                       // the pylon's ID
  id: string;                          // what session close takes: herdrPane, or failed-<hash> for a failed session in no pane
  harness: "claude-code" | "pi" | "shell";  // an agent Nexus does not start, such as one run by hand, reads as shell
  harnessSessionId: string | null;     // the Claude Code session ID or the pi session file, which a wake resumes
  status: "working" | "idle" | "blocked" | "done" | "unknown";  // Herdr's, when last read running. unknown if never
  title: string | null;                // the session's title, its Herdr workspace's label. null when last observed by a probe from before 0.5.0
} & (
  | { state: "running"; herdrPane: string; message: null }         // open in its pane
  | { state: "paused"; herdrPane: string | null; message: null }   // its pylon is paused, and its wake brings it back. herdrPane is the pane it had. Never set once the pylon runs
  | { state: "failed"; herdrPane: string | null; message: string } // the last wake did not bring it back, and message says why. The next wake tries again.
);                                     // herdrPane is the pane it left behind, such as a shell its agent would not start in, or null
type OpenedSession = { herdrPane: string; harness: "claude-code" | "pi" | "shell"; title: string };  // what session open prints
type Preview = {
  pylon: string;      // the pylon's ID
  service: string;    // the service it previews: a declared or ad hoc service, or port-<port> for a linked port
  httpsPort: number;  // the https port on the pylon's node, fixed for the thread's life
  ready: boolean;     // the node publishes it and warmed its URL, and the running pylon's node does not report its service starting, stopped or failed, or its port unrouted
  failed: string | null; // why it cannot answer: the pylon's node last reported its service failed, or its port without a route into the pylon. Null otherwise, and while the pylon is not running
  url: string;        // https://<node's MagicDNS name>:<httpsPort>/. Use it as it is rather than building it
};
type ListeningPort = {
  port: number;              // a TCP port that a preview can reach in the pylon
  service: string | null;    // the service that owns the port, or null for a process no service runs
  preview: Preview | null;   // that service's preview, or null while it has none
};
type Listing = {
  path: string;   // relative to the checkout. "" for the checkout itself
  entries: { name: string; kind: "file" | "dir" | "symlink" | "other"; size: number | null }[];  // size for a file only
  truncated: boolean;
};
type Base = { kind: "start" | "head" | "turn"; commit: string | null };
// start: what the pylon booted at; head: HEAD; turn: the snapshot before the latest reply.
// commit is null for an empty-tree start/head; turn always names its hidden snapshot commit.
type Changes = {
  base: Base;
  files: {
    path: string;
    oldPath: string | null;   // for a rename
    status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";
    additions: number | null; // lines. null for a binary file
    deletions: number | null;
  }[];
  truncated: boolean;
};
type Diff = { base: Base; diff: string; truncated: boolean };
// In ThreadDetail:
//   sessions: Session[]               every Herdr pane in the pylon and every failed session, as its node last reported them, or what its wake brings back while it is paused
//   previews: Preview[]               every preview of the thread, served or not, listening or not
//   ports: ListeningPort[] | null     in port order. [] while the pylon is not running. null while its node could not read them
```

The control plane also serves `POST /v1/images`, which records the manifest of an image built outside it, such as a local stack's Docker image. The CLI leaves it out.

## Failures

A failed command prints nothing on stdout and exits with one of these codes:

| Exit | Kind | Meaning |
|---|---|---|
| 0 | | Success |
| 1 | `failed` | The API answered 5xx, 422 for a request that waiting cannot change, such as `unpreview` of a port a service's preview owns, or something unexpected |
| 2 | `unreachable` | No reply. The proxy is down, the node is offline, the control plane is not running, or 30 seconds passed with no data from the proxy or the API |
| 3 | `refused` | 403 or 415. The API does not allow this machine, or a request check failed |
| 4 | `not-found` | 404. No such thread or project, or no session open in that pane, or another session than the one listed runs there |
| 5 | `conflict` | 409. The thread's state forbids the action, for example a message to an archived thread or a close of a paused session, or a project with that ID exists |
| 64 | `invalid` | Bad flags or arguments, a config file that cannot be read or parsed, or a 400 or 413 from the API |

Without `--json`, stderr gets one line, `nexus: <message>`. With `--json`, stderr gets one JSON line, `{"error": string, "kind": Kind, "status": number | null}`. `status` is the API's HTTP status, or null when there was no reply. When nothing listens on the proxy, the message says so and points to `ts-home status`.

## The watch stream

`nexus watch <thread> --json` follows the thread's conversation, or a Claude worker thread's transcript, as the control plane streams it, polls the rest of the thread every `--interval` milliseconds, 2000 by default, and prints one compact JSON object per line. Each object has a `type` and the `thread` ID.

The conversation streams from `GET /v1/threads/<thread>/events`, as server-sent events whose data is a `ViewFrame` from [`src/control/api.ts`](../src/control/api.ts). pi-durable commits an answer as it is written at most every 100 ms, and the output of a running tool on the same throttle, so `live` comes up to ten times a second while the agent writes. A change to the conversation prints within one commit, and a change to the pylon, its ports or the thread's status within one interval.

```ts
type RenderedEntry = { entry: EntryRecord; text: string };
type RenderedClaudeEntry = { entry: ClaudeEntry; text: string };
type WatchEvent =
  | { type: "reset"; thread: string; entries: RenderedEntry[] }
  | { type: "entry"; thread: string; entry: EntryRecord; text: string }
  | { type: "claude-reset"; thread: string; session: string | null; dropped: number; entries: RenderedClaudeEntry[] }
  | { type: "claude-entry"; thread: string; entry: ClaudeEntry; text: string }
  | { type: "state"; thread: string; status: "active" | "idle" | "archived" | "deleted";
      run: "idle" | "working" | "parked"; parkedTasks: number; queued: number;
      pylon: ActualState; failed: string | null; ports: ListeningPort[] | null }
  | { type: "live"; thread: string; queued: string[]; tools: { callId: string; output: string }[];
      partial: string | null; retry: string | null }
  | { type: "error"; thread: string; kind: "unreachable" | "failed"; message: string };
```

The stream follows these rules:

- The conversation route serves pi-durable's active context, not the full history. The context is a list of entries, and a new head marker, a compaction or a delete can reorder it or drop entries from it. Do not assume that IDs increase along the list, or that an entry stays in it.
- `reset` carries the whole active context, in the order the route serves it. A consumer replaces everything it shows with this list. A watch prints a `reset` before any `entry` or `state`, once it has both the thread and its conversation, so a consumer that restarts the watch starts from a fresh snapshot. There is no resume from an entry ID. Later, a `reset` comes whenever the context changes in any way other than new entries at its end.
- `entry` is one entry appended to the end of the context last printed. Within one watch, each appended entry is printed once.
- `text` is the CLI's plain rendering of an entry's messages. It is empty for an entry with no model message, which a consumer can skip. `entry` is the entry exactly as the conversation route serves it.
- While a thread has no conversation, such as after its delete, the context last printed stands and no `reset` comes.
- `state` comes after the first `reset`, and again whenever any field changes. `run` is `working` while the agent's run is busy. It is `parked` while tasks that hit the restart limit hold the run, which `nexus retry` clears. `queued` counts messages that wait for the run to finish. `pylon`, `failed` and `ports` are the pylon's `actualState` and `failed`, and the `ports`, from `ThreadDetail`. So a `state` comes when a port starts or stops listening, gets a preview, or its preview becomes ready.
- `live` comes after the first `state`, and again whenever any field changes. Every line comes from the latest of both sources, so the `entry` of an answer comes before the `live` that drops its `partial`. It is what the run in flight shows before it is committed to the context: `queued` holds the text of each message waiting to join the run, `tools` the output so far of each tool call still running, keyed by the `toolCall` part's `id` in the entries (a call whose result the entries already hold is done, whatever `tools` says), `partial` the text of the answer streaming now, and `retry` the error of a model request waiting to be retried. A quiet thread's `live` is `{ queued: [], tools: [], partial: null, retry: null }`. Only `--json` prints it.
- A Claude worker thread has no Nexus agent conversation, so its watch prints no `reset` or `entry`. It prints `claude-reset` and `claude-entry` instead, from `GET /v1/threads/<thread>/claude/events`, the same transcript watch that the dashboard's stream follows, so an entry prints as soon as the control plane reads it: within 2 seconds while a turn runs, and after each session event otherwise. `claude-reset` carries the transcript's kept entries, at most 3,000, and `dropped` says how many older ones are not kept. It comes first, and again only when the transcript was replaced, such as by a new session. `claude-entry` is one entry appended since, and each prints once within a watch, across reconnects too. `text` is the CLI's plain rendering, as `conversation` prints it, with a failed tool result as `[tool error]` and empty for an entry that prints nothing alone, such as a successful result or the same pull request again. `state`'s `run` is `working` while a turn of Claude's session runs, and `queued` counts what Claude Code queued and has not taken. In `live`, `queued` holds those messages' text, and `tools` has each call of the running turn without a result, with an empty `output`, because Claude Code writes none until the call ends. `partial` and `retry` stay null. A control plane older than the route answers it 404, so the watch prints one `error` that says to upgrade it or run `nexus conversation <thread>`, and goes on printing `state`.
- `error` reports that the control plane is unreachable or failing. The watch keeps polling, and opens a dropped stream again after 100 ms, then after twice as long each time it fails, up to the interval. An outage prints one `error` per distinct message, whether the poll or the stream failed with it. Once both work again, `state` is printed again, which means the control plane is back.
- The stream ends with exit code 0 after the `state` whose `status` is `deleted`, or at SIGINT, SIGTERM or SIGHUP, or when the reader closes the pipe, or when the process that started it has exited, noticed at the end of the poll and interval under way, so a consumer killed outright leaves no watch behind. An unknown thread exits 4, and a refusal exits 3, with the usual stderr line.
- A consumer must ignore event types and fields it does not know, so that later versions can add them.

## Pull requests (0.12.0)

`nexus show` includes linked PR outputs, their metadata and one PR-watch status line. No token configured means `PR watch: off`, both here and in the dashboard's Pylon outputs. Reading this information does not wake a pylon.

`ThreadDetail` adds:

```ts
prWatch: { enabled: boolean; stopped: boolean; error: string | null };
pullRequests: {
  repo: string;                       // owner/repository
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  checks: "pending" | "passing" | "failed" | "none";
  review: string;                     // currently none, approved, changes_requested
  conflict: boolean | null;          // null until GitHub knows
}[];
```

`enabled` means a control-plane token is configured; `stopped` means the durable ten-comment-only-wake cap was reached, not that the thread is archived. `error` reports a retryable read or delivery failure. Archived/deleted threads retain their last snapshots without polling, except that the merge state of a thread a queued thread waits for is still read, as [Queued threads](#queued-threads-0270) describes. Terminal PRs retain their last check/review summary. A closed PR rediscovered as open resumes watching with its existing cursor, without replaying old feedback or resetting the comment-wake cap. `outputs` also includes `{ thread, kind: "pull-request", ref: <PR URL> }` for each link. `events --kind pull-request.linked` follows each link as the watch saves it, once per pull request, with its `repo`, `number`, `url`, `title` and `state`.

Automated wake entries have `kind: "nexus.pr-watch"` and `data: { sender: "Nexus PR watch" }`, and their user-model message text starts with `[Nexus PR watch — automated, not a message from the person]`. This attribution is preserved in `conversation` and `watch` entries and is shown by the dashboard. It does not count as human activity. Consumers must not interpret every user-model message as coming from the person. A Claude worker thread gets the same text typed into its session, so its `conversation` shows it as a prompt starting with that prefix.

PR-watch feedback is forwarded only for GitHub `author_association` values `OWNER`, `MEMBER` and `COLLABORATOR`, including when the commenter is the PR author. Other or missing associations are ignored without consuming the comment-wake limit. This applies to reviews, review comments and issue comments.

## Deployments (0.13.0)

`deploy` accepts `main` or a full lower-case 40-character commit. The control plane resolves main, records the authenticated caller and time, and returns the same `ReleaseView` that `release` reads:

```ts
interface ReleaseView {
  desired: { commit: string; requestedBy: string; requestedAt: number } | null;
  nodes: Array<{
    node: string;
    role: "control" | "probe";
    commit: string | null;   // the release behind the role's current link
    target: string | null;   // the attempted desired release
    state: "pending" | "waiting-for-control" | "waiting-for-idle" |
           "installing" | "healthy" | "rolled-back" | "failed";
    reason: string | null;
    observedAt: number;     // control-plane receipt time, milliseconds since epoch; 0 before first report
  }>;
}
```

Missing or 90-second-old reports are pending with a reason; a probe-only node has no control row. CLI `--wait` polls every second for up to 30 minutes. Every configured component must report healthy at the full desired commit, freshly. Transient connection failures during control restart are retried. A rollback, terminal failure or deadline exits 1 with the component reasons; supersession by another release exits 5. Caller refusal is 3, invalid syntax is 64, and other transport/HTTP failures use the existing exit-code contract. Without `--wait`, success means the desired release was recorded, not deployed. `--json` prints one ReleaseView on success and the normal CLI error contract on failure.

Release changes require both ordinary API admission and `deployers` membership. Configured infrastructure nodes and the control node itself are always excluded, even if listed. No new in-pylon CLI command is added. Node-only polling/reporting routes are not client routes: they require the node's tailnet identity and root token. See [deployment setup](../deploy/README.md#one-time-setup-by-the-person-after-merge).

## Images (0.22.0)

The `image` commands build the pylon image and make it current, as [the deploy guide](../deploy/README.md#build-the-pylon-image) describes. `build`, `rollout` and `rollback` need the caller to be among the control plane's `deployers`, as `deploy` does, and fail with exit code 3 otherwise. Under [the merge policy](merge-policy.md) an image rebuild always needs the person, so agents never run them.

The control plane runs one image operation at a time. It is stored in the registry and advanced every 2 seconds, so it carries on across a control plane restart:

```ts
type ImageOperation = (
  | { kind: "build"; release: string | null }   // the release whose recipe the build sent, which it records
  | { kind: "rollout" }
) & {
  image: string;             // img-<12 hex> as `nexus image build` makes it; POST /v1/images takes any img-<1 to 40 lowercase letters or digits>
  requestedBy: string;       // the caller's stable tailnet node ID
  requestedAt: number;       // Unix milliseconds
  steps: Array<{
    node: string;
    state: "pending" | "running" | "done" | "failed" | "skipped";
    job: { id: string; notAfter: string } | null;   // the probe job last sent for this step
    reason: string | null;   // why it failed or was skipped, or "recorded already" for a build that needed no job
  }>;
} & ({ state: "running" } | { state: "done"; finishedAt: number } | { state: "failed"; finishedAt: number; reason: string });

interface ImagesView {
  current: string | null;
  previous: string | null;   // the image current before the last rollout, which rollback makes current again
  images: ImageEntry[];      // newest build first
  operation: ImageOperation | null;   // the running operation, or the last one
}
interface ImageEntry {
  id: string; gondolinBuildId: string; pins: object; sha256: string;
  builtOn: string; builtAt: string;   // ISO 8601
  release: string | null;    // the control plane release whose recipe it was built from, null when recorded by hand
  nodes: string[];           // the nodes whose last observation lists it
}
```

`build` has one step, on the image build node. A recipe already recorded answers 200 with a `done` build at once, and no job is sent. Otherwise the build answers 202 while it runs. `rollout` has one step per node. A node that is offline when it begins is `skipped`. Each other node is `done` once its observation lists the image, after a `fetch-artifact` job from a node that holds it, checked against the recorded sha256. The image becomes current only when no step is pending, running or failed. `rollback` is a rollout of `previous`.

Each command answers 409, exit code 5, while another operation runs, when the image build node is unknown or offline, when no online node holds the image to roll out, or when there is no previous image. Asking for the operation that runs again returns it. `rollout` of an image that is not recorded answers 404, exit code 4.

Without `--wait`, success means the operation started. `--wait` polls `GET /v1/images` every 2 seconds for up to 45 minutes and retries connection failures, so a control plane restart does not end it. It exits 0 when the operation is done, 1 with its reason when it failed or the wait timed out, and 5 when another operation replaced it. Plain `image list` prints one line per image, its role (`current`, `previous` or `-`), when and where it was built, its release, and its nodes, then the last operation and its steps.

## Templates at thread start (0.23.0)

`start` reads the project's `.nexus/setup` at the thread's branch tip, or at `--commit` when that is a full 40-character commit ID, straight from the project's remote. When the thread's node holds a ready template of that setup, built less than 72 hours ago, the pylon boots from it: it copies the template's disk, fetches, and checks out the commit that was read, then runs `.nexus/resume`. `.nexus/setup` does not run again. Otherwise the pylon boots fresh and runs `.nexus/setup`, as before 0.23.0. The first start of a setup on a node also asks the node to build a template of it, for the threads after it. A start of a scratch project, a start whose `--commit` is not a full commit ID, and a start whose remote the control plane cannot read within 15 seconds boot fresh.

`Thread.setup` records the path, and is absent from a thread started before 0.23.0:

```ts
type ThreadSetup =
  | { how: "template"; template: TemplateId; builtAt: number; commit: string } // commit: the full ID the pylon checks out
  | { how: "fresh"; reason: string; building?: TemplateId }; // building: the template this start found or asked for
```

Plain `show` prints it after the placement line, such as `setup: from template tpl-3f2a9c1b0d4e, built 2h ago, then checked out 91ce5419faae`, or `setup: fresh boot runs .nexus/setup, because no template of this setup is on rj-firebat yet; tpl-3f2a9c1b0d4e builds for the next thread`. When a template's build failed, the reason ends in its log, of which plain `show` prints the first line and `--json` all.

## Placement (0.25.0)

`start` boots the thread's pylon on its project's default node unless `--node` names another. `--node auto` sends `"node": "auto"` to `POST /v1/threads`, which picks the node where the pylon fits best, as [the design's placement](design.md#placement) describes. Among the online nodes that hold the current image, every secret the project grants, and a git SSH key if the repository or the dotfiles use SSH, it takes the one with the most memory left after the pylon, then the most CPUs, then the most free disk. A node where the pylon's memory or disk does not fit is left out, and so is an overcommitted node, one whose committed memory already exceeds its memory, with a reason such as `rj-firebat is overcommitted, with 40 of 22.8 GiB of memory committed`. When none can run it, the start fails with exit code 5 and names each node's reason, such as `no node can run this pylon: infra-testbench has 28 of 32 GiB of memory committed, and the pylon needs 8; rj-firebat does not hold image img-0123456789ab`, and no thread is started. The control plane refuses a node named `auto` in its config. Each start reserves its pylon's room on the node it chose, named or auto, until the pylon's registry row counts it, so two overlapping `auto` starts never take the same room.

A project's `defaultNode` may be `auto`, and then `start` without `--node` places the pylon as `--node auto` does, with `placement.how` `auto`. `--node <name>` still pins the pylon, with `how` `named`. `project add` without `--node` and the dashboard's new-project dialog both make `auto` the default, because the person wants work spread across nodes, and `auto` already refuses a node that lacks the image, the project's secrets or a git SSH key. So a new project needs a pinned node only when it must run on one machine. The cost: when no node has room, a start fails with each node's reason instead of booting into an overcommitted node. `project edit <id> --node auto` makes an existing project's default `auto`, and nothing changes an existing project's default on its own.

`Thread.placement` records the choice, and is absent from a thread started before 0.20.0:

```ts
type Placement =
  | { how: "default" | "named"; node: NodeName }
  | { how: "auto"; node: NodeName; weighed: Array<{ node: NodeName; left: Room } | { node: NodeName; refused: string }> };
/** What the node would have had left after the pylon. CPUs may be below zero. */
interface Room { cpus: number; memoryGiB: number; diskGiB: number }
```

Plain `show` prints it after the pylon and size lines, such as `placement: rj-firebat, the project's default node`, or `placement: auto chose rj-firebat, which had the most room left after this pylon; infra-testbench had 4 GiB memory, 2 CPUs and 80 GiB disk left; rj-firebat had 40 GiB memory, 10 CPUs and 300 GiB disk left`.

`NodeSummary.capacity` is `{ cpus, committedCpus, memoryGiB, committedMemoryGiB, diskFreeGiB, committedDiskGiB }`, or null for a node never observed. A pylon commits its CPUs and memory while its VM is up and its disk size until it is deleted, so a paused pylon counts toward `committedDiskGiB` only. Plain `nodes` prints it as `6/16 CPUs, 16/62.8 GiB memory committed, 120 GiB disk committed, 180.3 GiB disk free`, with `, overcommitted` after the memory figure for an overcommitted node. A probe from before pylons were counted reports no CPUs and no committed disk, and its committed memory is always 0. The fields it lacks are left out of `--json`, and plain `nodes` prints `unknown` for them and for its committed memory.

Committed CPUs and memory count every VM on the node whose controller is alive: running and booting pylons, check and reviewer threads, and orphaned VMs that the registry has not placed there. `NodeSummary.overcommitted` is true when the probe's committed memory exceeds the node's memory, and false for a node never observed or whose probe predates the count. `NodeSummary.pylons` sorts the pylons in the node's latest observation by what they hold, and is null for a node never observed:

```ts
interface Tally { pylons: number; cpus: number; memoryGiB: number }
interface NodePylons {
  up: Tally;       // every phase but stopped, and broken but for a controller that exited: holds its CPUs and memory
  paused: Tally;   // stopped, thread not archived or deleted: a wake needs its CPUs and memory back
  archived: Tally; // stopped or crashed, thread archived or deleted: holds only its disk, and boots only once the thread is unarchived
  crashed: Tally;  // broken because its controller exited or failed to boot the VM, thread not archived or deleted: holds only its disk, and a retry needs its CPUs and memory back
  orphaned: PylonId[]; // in the observation but not placed on this node by the registry, so its resources are unknown
}
```

A tally's CPUs and memory are what each pylon's boot asked for. Plain `nodes` prints the classes that have pylons on a line under the node, such as `  pylons: 5 up holding 20 CPUs and 40 GiB, 1 paused needing 8 GiB to wake, 3 archived, 1 crashed needing 8 GiB to retry, 1 orphaned (pylon-x)`. A control plane older than 0.25.0 sends neither field, so plain `nodes` then prints no mark and no `pylons` line.

### A thread's size (0.25.0)

`start --cpus n --memory GiB --disk GiB` sizes the thread's pylon over its project's `resources`. It sends `"resources"` in the body of `POST /v1/threads` with only the fields given, such as `{ "memoryGiB": 12, "cpus": 2 }`, and each field left out is the project's. Each is a positive whole number. The CLI refuses a negative number or one that is not whole with exit code 64 before it sends a request, and the API answers 0, like any other value it refuses, with 400, which is exit code 64 too. The dashboard's start dialog has CPUs, memory and disk fields whose placeholders show the picked project's size, and sends only the fields filled in.

The size is frozen into the pylon's boot when the thread starts, with its repository and grants. Every wake, unarchive and pylon retry boots that size, and a later `project edit` of `resources` changes only new threads. `--node auto` weighs the thread's size, and the start reserves it, so a node with room for the project's size but not the thread's is refused with the thread's number, such as `infra-testbench has 24 of 32 GiB of memory committed, and the pylon needs 12`.

A template's disk is its project's size, and a pylon's disk size is fixed once it exists, so a start whose `--disk` differs from the project's boots fresh, and its `setup` says so. A start that changes only CPUs or memory can boot from a template as any other does.

`ThreadDetail.pylon.resources` is the size, `{ cpus, memoryGiB, diskGiB }`. Plain `show` prints it after the pylon line, such as `size: 2 CPUs, 12 GiB memory, 10 GiB disk`. A control plane older than 0.25.0 sends none, and plain `show` then prints no size line.

## Reviews and landing (0.18.0)

`review` starts [the review loop](design.md#the-review-loop-and-landing) for the thread's open pull request, the one the PR watch linked, and prints the review it started. The control plane starts a reviewer thread on another model than the builder's, which is listed in `threads` like any other, as is each short-lived check thread, started by `nexus-check`, that runs `.nexus/check` and is deleted after its verdict. It runs the rounds itself, so the command returns at once and the Mac can sleep. `--pr N` names the PR when the thread has several open. `--rounds N` caps the rounds, one review each, at 5 by default, from 1 to 5. Since 0.24.0 a review never runs more than 5 rounds: `--rounds` above 5 fails with exit code 64, and a review stored with a higher cap reads `maxRounds: 5` and stops there. A reviewer's repeat approval of an unchanged head does not count, and a check that cannot run, or that fails at a head the builder does not move, ends the review for the person without another round. `--land` lands the PR under [the merge policy](merge-policy.md) once the reviewer approves it and `.nexus/check` passes at the approved head: merge, then for Nexus's own repository deploy and wait for health, rolling back if it does not come. A Claude reviewer's approval never lands: a landing it approved ends in `decision` for the person, and a review without `--land` still ends `approved`.

Since 0.26.0 a review ends without asking the person when nothing is left to review. A pull request closed without a merge ends it `closed`, and one merged outside a review without `--land` ends it `merged`. The loop reads the PR watch's state before each step, and GitHub itself before it sends a message, starts a check or ends the review, so it runs no check, starts no round and adds no label for a pull request that is no longer open. A review with `--land` still sees a merge made outside it through, and deploys it only if the merge policy holds, as before. A builder or reviewer thread the person archives or deletes ends the review `cancelled`, and `show` names that thread. None of these sets the `decision` attention, and a new `review` can start after any of them. Failures the person did not cause, such as an agent that gives no answer or a check that cannot run on an open pull request, still end in `needs-person`.

Since 0.27.0 a review can start with no command. A project edited with `--auto-review review` gets a review of each builder's pull request once the PR watch first links it open, and `--auto-review land` lands it too, exactly as `review --land` would, for the deployer who turned it on. `show` and the dashboard say `started on its own` on such a review's line. It never starts for a reviewer or check thread, or twice for one pull request: a review that ended stays ended, and `review` still starts one by hand. A landing checks before every merge that the caller it lands for, the one who asked or the one who turned on landing for the project, is among the control plane's `deployers`, and that the project still asks, and holds for the person with that reason when not. A landing held only because the branch conflicts with its base, or refused by GitHub while GitHub then reports the conflict, no longer ends with the person: the builder gets a `CONFLICT` finding (P0) to rebase onto the current base, resolve the conflicts keeping both sides' intent, run the checks again and push with `--force-with-lease`. The rebased head gets a new round under the same cap, then the check and the landing. A head pushed after the approval for any other reason also gets a new round rather than holding for the person. A builder that rejects `CONFLICT`, or pushes nothing for it, ends the review for the person with its reason, and a conflict after the last round ends it with the label. A review held for the person (`needs-person`) that never merged now also ends `closed` when its pull request is closed and `cancelled` when its builder is archived or deleted, so the builder no longer shows `decision`. One that merged, held over its deploy or rollback, stays.

`land` lands a review that ended approved, or tries again one the policy held after its check passed, such as after the PR's description changed or the person granted the merge token. It runs the check again first, which reads the kept result for the same head. A review that already merged never lands again. The Land button on the builder's dashboard page calls the same route with `{"head": string}`, the approved commit its confirmation named, and the route answers 409 and lands nothing when the review is at another commit. `land` sends `{}`, which lands the review at whatever commit it approved.

Since 0.28.0 the dashboard can land a review past the holds [the merge policy](merge-policy.md#what-the-person-may-waive) lets the person waive. Since 0.30.0 its Land button sends `{"head": string, "waive": string[]}` to the land route, which lands the review at that head with the named holds met at that commit only. It answers 409 unless the review has each named hold at that head and each is one the person may waive, and 400 for a `waive` without `head`. It needs a deployer, as `land` does. `land` sends no `waive`, so a hold reserved for the person holds the landing again.

Both fail with exit code 5 when the control plane has no GitHub token (`github.tokenFile`), for an archived or deleted thread or a reviewer thread, when the thread has no open linked PR or several and no `--pr`, when its review is still running, when no reviewer on another model can run (a harness builder whose project grants no Claude token), and, for `land`, when the review is not approved. Landing deploys, so `review --land` and `land` need the caller to be among the control plane's `deployers`, as `deploy` does, whatever the repository, and fail with exit code 3 otherwise. A review that stops at approval needs no such right. Invalid numbers fail with exit code 64.

`ThreadDetail.review` is the thread's latest review as a builder, or null:

```ts
interface Review {
  id: string;                         // rv-<8 hex>
  expect: string;                     // the token the awaited answer echoes
  sent: number;                       // messages sent, which number their request IDs
  builder: string; reviewer: string;  // thread IDs
  pr: { repo: string; number: number; url: string; title: string; branch: string };
  models: { builder: string; reviewer: string };
  reviewerKind: "harness" | "claude";   // only a harness reviewer's approval lands
  maxRounds: number;                  // 1 to 5
  land: { requestedBy: string; fromProject?: true } | null;  // fromProject: the project's autoReview asked, and is read again at each landing
  auto: boolean;                      // started on its own when the PR watch first linked the PR
  merged: string | null;              // the merge commit once merged
  waiver: { head: string; holds: string[]; by: string; at: number } | null;  // since 0.28.0
  rounds: { head: string; verdict: Verdict | null; check: { passed: boolean; output: string } | null; answers: Answer[] | null; conflict?: { base: string } }[];
  phase: { kind: "reviewing" | "fixing" | "approved" }
    | { kind: "merging"; authorized: string | null }
    | { kind: "checking"; startedAt: number; thread: string | null }
    | { kind: "deploying"; commit: string; previous: string | null; requested: boolean; deadline: number }
    | { kind: "rolling-back"; commit: string; previous: string; why: string; requested: boolean; deadline: number }
    | { kind: "landed"; commit: string }
    | { kind: "needs-person"; reasons: string[]; label?: Label }
    | { kind: "merged" | "closed" }
    | { kind: "cancelled"; who: "builder" | "reviewer"; status: "archived" | "deleted" };
  outbox: { to: "builder" | "reviewer"; id: string; text: string; attempted: number | null } | null;
  since: number; nudges: number; startedAt: number;
}
```

`Verdict` and `Answer` are in [`src/control/review.ts`](../src/control/review.ts). Each of a verdict's findings has a `priority` of `"P0"` to `"P3"`, as [the merge policy](merge-policy.md) defines them, in place of the `severity` before 0.24.0. A stored finding with `severity` reads `"serious"` as `"P1"` and `"minor"` as `"P3"`. Only P0 to P2 findings block, and the builder answers only those. A verdict's `verdict` is `"approve"` exactly when none of its findings is P0 to P2, whatever the reviewer wrote.

`label` is the pull request's `needs human review` label. Only a review whose rounds ran out has one: the reviewer still requested changes after the last round, the builder pushed fixes after the last round, `.nexus/check` failed after the last round, the head moved after the last round's approval, or the branch conflicts with its base after the last round. A review that went to the person for any other reason has none.

```ts
type Label = { state: "adding" } | { state: "added" } | { state: "failed"; why: string };  // why is GitHub's answer
```

`show` prints one `review` line with the phase, the round and the reviewer, and one `needs you:` line per reason when the review ended for the person, whose attention is then `decision`. The review line ends with `adding the label "needs human review"`, `labelled "needs human review"` or `label "needs human review" not added`, as the label's state says. A label GitHub refused also adds a `needs you:` line that says why, such as a token that may not write issues or pull requests. The review loop's messages start with `[Nexus review — automated, not a message from the person]`; in a harness conversation they are entries of kind `nexus.review` with `data: { sender: "Nexus review" }`, and a Claude worker gets them typed as prompts. `events --kind review.changed` follows reviews as they start and change phase, round or label state. Since 0.28.0 a review the person landed past holds they waived also prints `waived by <node> at <commit>, <time>:` and one indented line per hold it waived, and `events --kind review.waived` follows each waiver with the review, the pull request and the waiver's fields. A review from an older control plane has no `waiver`, which reads as none.

## Queued threads (0.29.0)

`nexus start ... --after A[,B...]` queues a thread to start once the pull request of every thread it names has merged, whether the review loop landed it or someone merged it outside the loop. The builder that starts then branches from the default branch as it is, so the thread starts at the merge and does not wait for a deploy. The CLI sends one `POST /v1/threads` with the start's fields, `"after"`, the threads, and with `--message` its `"message"`. The control plane checks the start as it checks any start, records it and answers 201 with the `QueuedThread`, which `--json` prints. The text is `Queued <id> on <project>: <title>. It starts once A and B have merged their pull requests.`

A queued thread is not a thread yet. It has no row in `GET /v1/threads`, no pylon, no conversation and no Claude worker, and it holds no room on any node. It is a record that keeps the ID the thread gets when it starts, its title, project, who queued it (the thread's `startedBy` when it starts), the threads it waits for, and the start as it was asked for, frozen then:

- Its node is `--node` as given. Without `--node` it starts on the project's default node as it is when the thread starts, as any start does, and `node` shows that default meanwhile.
- Its size is `--cpus`, `--memory` and `--disk` where given, and the project's size at the time for the rest.
- Its branch, commit, Claude prompt and model are as given, and a Nexus agent thread's first message is `--message`.

The project's hosts, secrets and git identity, and the template the pylon boots from, are read when it starts, as any start reads them. Every thread route other than the ones below answers 409 for a queued thread, `thread <id> is queued, so it has no pylon or conversation yet`, or `thread <id> was cancelled while queued, so it has no pylon or conversation`.

### What each predecessor means

Each thread in `after` is one `Wait`. The control plane reads it from the predecessor's thread, its review and the pull requests the PR watch linked to it, every time it is asked, and stores none of it. So a pull request reopened after it closed, or merged after it was blocked, changes it. The first rule that holds decides:

| The predecessor | State | Why, as `why` says it |
|---|---|---|
| Was queued and has not started | `waiting` | `is queued` |
| Was queued and cancelled or deleted, or does not exist | `blocked` | `was cancelled while queued`, `was deleted while queued`, `does not exist` |
| Its review merged its pull request, or saw it merged outside the review | `landed` | `PR #<n> merged` |
| A linked pull request merged and none is open, even if the thread was archived or deleted since | `landed` | `PR #<n> merged` |
| Is archived or deleted | `blocked` | `is archived and its pull request did not merge`, or `is deleted ...` |
| Its review ended for the person | `blocked` | `its review ended for the person: <the first reason>` |
| Every linked pull request closed without merging | `blocked` | `PR #<n> closed without merging` |
| A linked pull request is open | `waiting` | `PR #<n> is open` |
| Has no linked pull request | `waiting` | `has no pull request yet` |

The PR watch reads a pull request every two minutes, so a queued thread starts up to about two minutes after the merge, plus one pass of the queue. It stops reading the pull requests of an archived or deleted thread, of one whose watch reached its ten comment-only wakes or holds a message it cannot deliver yet, and a closed one it does not find open again, and its search finds only open pull requests. For a thread a queued thread waits for, every pass first reads each linked pull request that has not merged and searches the thread's pushed branches for pull requests in any state, and saves their states together once every read is done: a merged, closed or reopened state, and an open one it finds linked unread as discovery would, so a merged one beside an open one never lands the thread. It sends nothing. So a predecessor merged and archived before the watch saw the merge, reopened and merged between two reads, or opened and merged between two reads, still lands. A review loop's reviewer or check thread merges nothing of its own, so `--after` refuses one. A queued thread may wait for another queued thread, which lands once it has started and its own pull request merged, so queued threads can form a chain.

### When it starts

The control plane looks at the queue every 15 seconds, and right after a start is queued. A queued thread whose every wait is `landed`, or one `start-queued` asked for, starts exactly as `nexus start` would start it with the recorded request, under its recorded ID. Placement and capacity apply as for any start. An `auto` thread goes to the node with the most room then, and when no node has room the start fails with `no node can run this pylon: ...`, so the thread stays queued and the next pass tries again, until a node has room. A thread on a named node starts there, as any start does, which never waits for room. Any other refusal, such as no current image or a deploy's drain, also leaves it queued. Each failure is the record's `lastError` until a start clears it.

A Nexus agent thread queued with `--message` gets it once it has started, as the person's message, under the request ID `queued:<id>`. The harness answers a repeated request ID with its first submission, so a send repeated after a crash is the same message. A Claude worker's prompt is its `--claude`, which starts it with `/poteto-mode` in front as any start does. `--message` with `--claude` is refused, and so is `"message"` without `"after"`, with `message is only for a queued start; send it with POST /v1/threads/<id>/messages`.

A queued thread starts once. Its record lives in the registry, so it survives a restart or a deploy of the control plane, and the transaction that inserts the thread's row marks the record started, so neither a crash, a restart, nor two attempts at once can start it twice. A queued start passes the deploy drain's gate: while a release drains the control plane, every queued start is refused and the thread stays queued, saying why, and starts after the release. The drain waits for a queued start already in flight, as it waits for any start.

### Starting it now, cancelling it, and listing it

`nexus start-queued <thread>` sends `POST /v1/threads/<thread>/start`, which starts a queued thread now without waiting for its predecessors, blocked or not. It answers 201 with the `Thread`, which `--json` prints, and the text is `Started <id> on <project>: <title>`. When the start fails, such as for an `auto` thread with no node that has room, it fails with that error, and the thread stays queued with `startNow` set, so a later pass starts it once it can. A thread that has started, been cancelled or been deleted is not queued, which answers 409.

`nexus archive <thread>` cancels a queued thread: its status becomes `archived`, which the CLI and the dashboard call cancelled, and it never starts. `nexus unarchive <thread>` queues a cancelled thread again. `nexus delete <thread>` deletes it, cancelled or not. Each answers the `QueuedThread`, and the text says so, as in `Archived <id>. Its queued start is cancelled.` A thread queued after a cancelled or deleted one is blocked by it.

`nexus threads` lists the queued threads after the others. Each row has the thread's ID, `queued` or `blocked`, the first wait that has not landed, as `waits for <thread>: <why>` or `blocked by <thread>: <why>`, its node, project, age and title. Cancelled and deleted queued threads are listed only with `--all`. `--json` prints the `ThreadRow[]` of the started threads alone, as before. `nexus threads --queued` lists only the queued threads, and `--json` prints their `QueuedThread[]`. A control plane older than 0.29.0 has no `GET /v1/queued`, so the CLI lists no queued threads from it.

`nexus show <thread>` of a queued thread reads `GET /v1/queued/<thread>` once `GET /v1/threads/<thread>` answers 404 or 409, and `--json` prints its `QueuedThread`. The text says its title, ID and project, whether it is `queued`, `blocked` or `cancelled`, its node, worker and model, its size, the first line of its prompt or first message, one line per predecessor (`waits for`, `landed` or `blocked by`, the thread and why), the last start attempt's error, and for a blocked thread `nexus start-queued <id> starts it now; nexus archive <id> cancels it.`

The dashboard lists a project's queued threads in the sidebar after its open threads, as `queued` or `blocked`, and the overview gives the project a Queued table of what each one waits for. A queued thread's page says what it waits for and what it will start with, and has Start now and Archive, or Unarchive once it is cancelled.

Queued threads need the control plane's GitHub token, which the PR watch and the review loop read merges with. Without `github.tokenFile`, `start --after` and `start-queued` answer 409 `queued threads need the control plane's GitHub token (github.tokenFile), which is not configured`.

```ts
/** A thread that has not started, as GET /v1/queued and GET /v1/queued/<thread> answer it. */
interface QueuedThread {
  id: string; title: string; project: string;
  startedBy: string;                       // who queued it, and the thread's startedBy once it starts
  createdAt: number;                       // when it was queued, in Unix milliseconds
  status: "queued" | "archived" | "deleted";  // archived is cancelled
  after: string[];                         // the threads it waits for, without repeats
  waits: Wait[];                           // one per thread in after, in its order
  blocked: boolean;                        // some wait is blocked
  node: string;                            // a node, or "auto"
  worker: "harness" | "claude";
  model: string | null;                    // a Claude worker's model, null for a Nexus agent thread
  prompt: string | null;                   // the first message, or the Claude prompt without /poteto-mode
  branch: string | null; commit: string | null;
  resources: { cpus: number; memoryGiB: number; diskGiB: number };
  startNow: { by: string; at: number } | null;  // start-queued asked for it
  lastError: string | null;                // why the last start attempt failed
}
interface Wait { thread: string; state: "waiting" | "landed" | "blocked"; why: string }
```

| Exit | When |
|---|---|
| 4 | A thread in `--after` does not exist, or `start-queued` names no queued thread (404) |
| 5 | The control plane has no GitHub token, or `start-queued`, `archive` or `unarchive` of a queued thread whose status does not allow it (409) |
| 64 | `--after` names no thread or more than 32, names a reviewer or check thread, or `--message` goes with `--claude` (400) |

## Project editing (0.14.0)

`nexus project edit <id>` calls `PATCH /v1/projects/<id>` and returns the updated `Project` with `--json`. It accepts `--node`, which takes a node or `auto`, `--branch`, `--cpus`, `--memory`, `--disk`, repeated `--allow-host`, `--login`, and `--secret`, plus `--git-name NAME --git-email EMAIL` and, since 0.27.0, `--auto-review off|review|land`. Omitted settings stay unchanged. Supplied host, login and secret lists **replace** their lists, rather than appending. Include grants you want to keep. `--clear-hosts`, `--clear-logins`, and `--clear-secrets` empty their lists; each conflicts with supplying the corresponding list. `--clear-git-identity` removes the project override, reverting to the control-plane identity (or leaving git unchanged when neither is configured).

For example, for each of `nexus`, `claude-mods` and `pi-nexus`, include its existing grants and logins alongside the new ones:

```sh
nexus project edit nexus --login claude --secret GH_TOKEN:api.github.com,github.com --secret CLAUDE_CODE_OAUTH_TOKEN:api.anthropic.com
nexus project edit nexus --git-name "Example Person" --git-email person@example.com
```

These examples do not install secret values: the person must provision `CLAUDE_CODE_OAUTH_TOKEN` in the chosen node's secret file. Grant hosts must be explicit hostnames, never wildcards or an empty list. Secret names must be unique: list all of a secret’s hosts in one grant. Both add and edit refuse duplicate names with exit 64 (API 400). Add and edit share API validation. A missing project returns 404 (CLI exit 4), invalid settings or immutable fields return 400 (exit 64), and callers outside normal API admission are refused with 403 (exit 3).

The PATCH object accepts optional `defaultNode`, `defaultBranch`, `resources` (any of the positive integer fields `cpus`, `memoryGiB`, `diskGiB`; omitted fields stay unchanged), `allowedHosts`, `logins`, `secrets`, `gitIdentity` (`{name, email}` or null), and `autoReview` (`{land}` or null). Edits merge atomically with the stored project, including each resource field independently. It rejects `id`, `repoUrl`, `preSetup` and unknown fields. Names must be nonempty single lines and email addresses valid. `project add` also accepts the optional identity through its API.

Default node, branch, resources and grants apply to **new threads**, not existing pylons. Running and paused pylons retain their original boot network policy and secrets. `ThreadDetail.pylon.grantsOutdated` is true when the saved network settings differ from the project's current settings; plain `show` explains that a new thread is needed. This compares settings, not secret values or their rotation on the node. Archive/unarchive boots the checkpoint with the **saved** network options, so it does not apply edited grants. Publish or otherwise preserve work before moving to a new thread; do not delete the old thread until its work is safe.

Git identity is different: the next boot, including checkpoint wake, resolves the current project override or control-plane default and sets it globally for `user`, after the common dotfiles layer. A running pylon is unchanged. Neither configured means git is left as it is, including any identity already on disk. PYLON.md names the configured identity, or tells agents to ask the human rather than invent one. Identity contains only a name and email, never tokens.

`--auto-review review` makes [the review loop](#reviews-and-landing-0180) start on its own for each builder's pull request the PR watch first links open, `land` also lands each one it approves, and `off` stops both. The API stores `Project.autoReview` as `{ land, enabledBy }`, with the caller as `enabledBy`, and drops it for null, so `project add` cannot set it. `land` needs the caller among the control plane's `deployers`, as `review --land` does, and fails with exit code 3 otherwise. Reviews that already started keep going, and a landing reads the setting again before every merge. `projects` prints `auto review off`, `auto review, set by <caller>` or `auto review and land, for <caller>` for each project, and `project edit` prints the same in its line.

No agent-facing edit tool is added. Editing grants is a human action through the CLI/API. The dashboard's limited new-project dialog is unchanged; use the CLI for edits.

## Event stream and Claude workers (0.15.0)

```sh
nexus start --project P --claude '/poteto-mode implement the task and test it' [--model ID]
nexus attach <thread>
nexus events [--follow] [--since ID] [--thread T] [--project P] [--kind K]... [--json]
```

`--claude` supplies a Claude Code worker's first prompt instead of sending work to
the Nexus harness. It is mutually exclusive with `--message`; the prompt supplies
the default title. A prompt not already beginning with `/poteto-mode` is prefixed
with it. The API accepts the same optional `claude` string on `POST /v1/threads`,
and the dashboard's start form offers Claude Code as its default worker, with the prompt as its main field. Empty means the existing
harness workflow. API prompts are at most 16,384 characters, may span lines and
hold any characters but NUL, and reach Claude exactly after trimming.

Starting returns the thread while its pylon boots. Nexus opens the worker once
it is running. The first prompt is a literal initial Claude argument, not terminal
keystrokes, so it cannot race a prompt becoming ready. Claude sessions launched by
Nexus, including resumes, use `--permission-mode bypassPermissions`: the pylon is
the sandbox. The project's `CLAUDE_CODE_OAUTH_TOKEN:api.anthropic.com` secret grant
uses the existing per-boot environment placeholder, never a stored real token.
Without that grant, the existing `/login` workflow still applies. The pstack
plugin must be present in the image's captured agent setup.

Use `show --json` to inspect `claudeWorker.state` and its optional failure `message`.
`started` means the launch reached UserPromptSubmit (or a live Claude is observed
working), not task completion.
Nexus waits up to 30 seconds after typing the launch command for a launch-specific local hook
receipt. No receipt or live busy-process evidence means `stalled`, with the last 20 pane lines (up to 8 KiB) in
the message and a `thread.failed` event. Attention is `failed`, ahead of other
attention values. The pane stays open for attach; no automatic resubmission occurs. A late
turn-started report from this launch's session changes it to `started` and clears
the current diagnostic, letting attention follow working/reply/seen normally.
The stall remains in the event history.
Before every Claude launch or resume, Nexus merges onboarding completion, theme
(default dark), checkout trust and bypass acceptance into Claude user state.
Existing credentials, preferences, hooks and file modes are retained. Already
seeded files are not written; concurrent changes detected before replacement
are re-merged, up to five attempts. Trust is restricted to the pylon checkout,
never a restored pane cwd, root or HOME. A launch that loses its probe connection,
as when a deploy restarts the probe, stays `starting` while Nexus waits up to three
minutes for the probe to come back, then carries on from what the pylon shows: it
types the launch only if it was not typed before, and never starts a second Claude.
After a launch failure, attach and inspect before starting another session; Nexus
deliberately does not otherwise retry a possibly submitted task. Human takeover and
pause/wake use the same Herdr pane and Claude resume path as `session open`.
A Claude worker thread's conversation is its Claude Code transcript, and `send` steers
it, as the next section describes. Harness abort/retry and latest-turn snapshots do not apply to it.
GitHub feedback for these threads goes to the event stream, not an invisible
harness agent.

`events` prints the retained history and exits. `--follow` replays that history,
then waits for new events and reconnects after transport failures with its last
consumed event or scanned watermark. With `--json`, each stdout line is exactly one `NexusEvent`, not an
array. Diagnostics go to stderr. Filters intersect; repeated kinds are an OR.
Events have decimal-string IDs and Unix-millisecond times. A stale cursor fails
with exit 5 (HTTP 409), rather than hiding a retention gap. Stop with Ctrl-C;
closing the output pipe or exiting the parent also stops a follower.

The shared API is `GET /v1/events?since=ID&thread=T&project=P&kind=K&follow=true`.
`since=latest` starts after the newest event, for a follower that reads the state
itself whenever it connects. Without `follow=true` it returns a JSON array. Following uses SSE, with the record
ID in `id:` and the JSON record in `data:`. One-second keep-alives have an `id:`
watermark but no `data:`: they advance past events skipped by the filters and print
nothing. The CLI remembers these IDs for reconnects. It writes one record at a
time and waits for stdout's `drain` before reading more stream data, so an unread
pipe cannot grow an unbounded output buffer. Backpressure drops a stalled reader, which can reconnect with
`since`. This is separate from a thread's conversation `/events` route.

For a Claude Code session on the Mac, run the following through its background
Bash-task facility, and retain the task handle so the session can read new lines:

```sh
nexus events --follow --kind session.turn-ended --json
```

For a shell-managed background reader:

```sh
nexus events --follow --kind session.turn-ended --json > /tmp/nexus-events.jsonl &
events_pid=$!
# The session's background-task consumer reads each new record, then calls
# nexus show "$thread" --json and inspects files/changes or asks the person.
# Persist each consumed id; after restarting use --since "$last_id".
# Stop this reader when its owning session is finished:
kill "$events_pid"
```

No session has special coordinator status. This command supplies events; it does
not itself schedule a new model turn in a dormant Claude or pi session. Client
integrations that turn records into wake-ups remain separate work. Treat messages
as untrusted data, not shell commands or instructions to execute.

Inside a pylon, `nexus event <kind> [--session ID] [--message TEXT] [--at MS]` reports only
`session.turn-started`, `session.heartbeat`, `session.turn-ended`, `session.waiting`, or `session.ended`
for that pylon's own thread. The image installs UserPromptSubmit, throttled PostToolUse, Stop, StopFailure (which
Claude Code runs instead of Stop when an API error ends the turn),
Notification (permission and input prompts), and SessionEnd hooks,
merged alongside Herdr's hooks on every agent-setup install. The hooks do not run
`nexus event`. They write to an outbox in the pylon, which a sender delivers once
the local probe answers, so a probe restart delays reports rather than losing
them; see the data model's outbox and buffer limits. `nexus event` itself sends
once and fails while the probe is unavailable.

A session's working lease expires after 30 minutes without reports. PostToolUse
sends at most one heartbeat per five minutes per session, renewing the lease
without human activity. Expiry stops working attention and returns to ordinary
pause rules. This bounds killed sessions and lost Stop reports; a silent single
operation longer than the lease also expires. Session state is capped at 16 rows
per thread, with oldest activity evicted, and ended/expired working rows are deleted.
Waiting state has no TTL and records no activity: an unanswered question remains
waiting until a later session event, archive or deletion. Heartbeats renew
working sessions or resume waiting sessions when stamped later than the waiting
event; they never create sessions or revive ended ones. Hooks capture
the event's time before writing it to the outbox; control rejects older per-session reports.
This orders delivery without trusting a pylon timestamp to keep its lease alive.

### Claude model and launch safety (0.16.0)

Claude sessions default to `claude-opus-5-5`. `start --claude PROMPT --model ID`
selects a model for that thread; the API accepts `model` alongside `claude`, and
the dashboard start form offers the same optional field. `--model` without
`--claude` is rejected. Nexus records the requested model, not a claim about a
provider's routing; old workers without a recorded model show unknown.
Explicit overrides survive checkpoint relaunches. Subscription/model refusals
remain visible in the pane; Nexus does not silently choose a cheaper model.

Herdr readiness timeouts do not kill a submitted first prompt. A local launch
receipt, or a live Claude process with working status, proves startup. Uncertain
first-prompt launches leave the pane open with stalled attention and a diagnostic;
attach before starting another session. No automatic resubmission occurs.
A matching late submission report clears failure; the old diagnostic remains in
history. A launch command error after a reported submission emits no false
`thread.failed`. `show` (text and JSON) and the dashboard expose the same current
worker state, model and diagnostic; session lists remain observed facts, not
invented sessions. All Nexus launches merge Claude's native empty commit and PR
attribution settings, preserving unrelated settings and hooks.

## Claude conversations and steering (0.17.0)

```sh
nexus conversation <thread>            # the Claude worker's transcript
nexus send <thread> 'another prompt'   # typed into the worker's Claude session
```

A Claude worker thread's conversation is the transcript Claude Code writes for the
worker's session in the pylon, `~/.claude/projects/<cwd>/<session>.jsonl`. The
control plane reads it over the probe's raw pipe, from where its last read stopped,
and keeps what it read in the registry. `GET /v1/threads/<thread>/conversation`
answers a `ClaudeConversation` for such a thread: `kind: "claude"`, the worker's
`session`, its `entries`, how many older entries were `dropped` (at most 3,000 are
kept), when it was last read (`readAt`), whether a turn runs (`working`) and, since
0.21.0, the session's `usageLimit` stop or null. An entry
is a prompt (with who it came from), a reply, a tool call, a tool result paired with
its call by ID, a background task's notification, a queue operation, a notice, a turn
duration, a pull request Claude opened, or a `record` that names a transcript record Nexus does not know yet, so a
newer Claude Code shows something rather than nothing. Claude Code writes a pull
request's record again each time it saves the session, so a consumer shows the first
`pull-request` entry for each `url`, as `conversation` and the dashboard do. Each text is cut to a limit and
marked where it was cut. A consumer must ignore entry kinds and fields it does not know.

Reading never wakes a pylon and is not human activity. The control plane reads only
while the node reports the pylon running. A paused pylon's thread shows the transcript
as of its last read, which survives a control-plane restart. The session events say
when to read: each `session.*` event for the thread is followed by a read, and while a
turn runs and a dashboard watches the thread, it is read every 2 seconds, so new
entries appear during the turn. An idle thread costs no reads. The conversation route
reads once, for up to 5 seconds, before it answers. `nexus watch` follows the transcript
as [the watch stream](#the-watch-stream) describes.

`send` to a Claude worker thread types the message into the worker's Claude session, as
a person at its terminal would, and submits it. It answers `{ "claude": { "session",
"outcome", "resumed" } }`. `outcome` is `sent` when Claude was idle, so the message
starts a turn, or `queued` when Claude was working. Claude Code then queues it as it
queues input typed during a turn. Claude reads a queued message at its next tool step
and answers it within the same turn, or takes it after the turn when no tool step comes.
The dashboard shows it as queued until then. `--steer` changes nothing for Claude.
`resumed` says that no pane ran the session, so Nexus resumed it with `claude --resume`
first.

Sending is human activity, so it wakes a paused pylon. Until the pylon runs, the API
answers 409, and the CLI and the dashboard try again once a second, for up to 120
seconds, with the same request ID. The pylon counts as running before its wake has
relaunched the worker's session, so a message that comes during the relaunch waits for
it in the pylon and goes to the pane the relaunch brought the session back in. The text arrives exactly as written, newlines, quotes,
backticks and dollar signs included, after CRLF becomes LF and the ends are trimmed.
Nexus types it in short pieces, because Claude Code takes a long burst of input as a
paste and wraps it in `<pasted_content>` tags. A tab, a carriage return or another
control character cannot be typed as written, so such a message fails with exit code 64
(API 400). As in Claude's terminal, a message that starts with `/` runs a slash command,
one that starts with `!` runs a shell command, and text a person has half-typed in an
attached terminal is joined to it.

A send to Claude never reaches the Nexus agent. The same request ID is never typed
twice: a repeat answers the first result. While Claude waits at a dialog in its
terminal, nothing is typed and the API answers 409, saying to attach and answer it.
If the session's pane stops running it before the message is typed, as when another
agent starts in that pane, nothing is typed and the API answers 409, saying the pane
stopped running the session. The next try resumes the session in a new pane.

Sends to one Claude session are typed one at a time, so a message can wait in the
pylon behind a slow one. The CLI waits up to 120 seconds for the API's answer, and the
API waits up to 90 seconds for the pylon's node. If that wait runs out, the send fails
with exit code 1 (API 503), but the message is still typed once its turn comes, and
the error says so and names the request ID. A repeat of that request ID types nothing.
It waits for the first send, for up to 90 seconds more, and answers what it did: exit
code 0 with its `claude` result, or 409 if it typed nothing after all, which a further
repeat types. If the probe fails partway through typing, the message may be partly in
Claude's prompt. A repeat of that request ID then fails with exit code 1 (API 422), and
the person checks the conversation before sending again under a new ID. So does a
repeat after the node's probe restarted, or more than an hour after the first send
settled, since the probe no longer knows how it went. A worker that has not started a
session yet answers 409.

## Usage-limit stops (0.21.0)

```sh
nexus threads                  # the stop, and when the limit resets, in place of working
nexus show <thread>            # attention: limited, and a usage limit line
nexus send <thread> continue   # once the limit resets, resumes the worker
```

When the Claude subscription runs out, Claude Code ends the worker's turn with an
error record, `You've hit your session limit · resets 5am (UTC)`. Nexus keeps it as a
`notice` entry whose `usageLimit` holds `resetsAt`, when the limit resets, in Unix
milliseconds, from the record's `apiErrorParams.rate_limit_info.resetsAt`, or null
when the record names none. Other API errors, such as a 529 overload or a 429 that
says it is "not your usage limit", stay plain error notices.

While the newest entry that is not bookkeeping is that notice, and no turn of a
session runs, the thread has `usageLimit` (`stoppedAt`, `resetsAt`) and its attention
is `limited`. Turn durations, queue operations, pull requests, unknown records and
Claude Code's own info notices, such as "Usage limit reached · continuing
automatically at 5am", are bookkeeping. `ClaudeConversation.usageLimit` holds the
same, or null. `threads` shows `stopped on its usage limit until 05:00 UTC` in place
of `working`, and `which reset at 05:00 UTC` once the time passed, `show` prints a
`usage limit:` line, and `conversation` ends with a line saying to send "continue"
after the reset. The dashboard shows the same text as the thread's state, keeps the
row bright, counts it in its badge and notifies at once. `limited` outranks `reply`,
because the turn end that recorded the reply is the stop itself, and seen does not
clear it. The next turn of the session clears it, whoever starts it.

Claude Code continues a session it still runs on its own, about 90 seconds after the
reset, with the prompt "Your claude.ai usage limit has reset. Continue the task…",
which `conversation` shows as a prompt from Claude Code. That timer is in the Claude
process, so a pylon that paused meanwhile loses it. Then `nexus send <thread>
continue` after the reset resumes the worker, as any send does, waking a paused
pylon. A send before the reset types the message, and Claude stops on the limit
again.

The control plane can do that send itself. With `"resumeAfterUsageLimit": true` in
its config, off by default, every 30 seconds it types `[Nexus usage limit — automated,
not a message from the person] The usage limit reset. Continue where you stopped.`
into each `limited` active or idle thread whose `resetsAt` passed three minutes ago,
which gives Claude Code's own continue time to come first. Each stop gets one message,
under the request ID `usage-limit:<session>:<stoppedAt>`, which a thread keeps, so a
restart never sends it twice. It wakes a paused pylon as other automated messages do,
as agent activity. It never types into an archived thread, so it never wakes a pylon
the person archived. A stop with no `resetsAt`, or with one no later than the stop, which would stop
the worker again at once, waits for the person. Each message it
typed appends a `usage-limit.continued` event with `session`, `stoppedAt`, `resetsAt`
and `requestId`, which `events --kind usage-limit.continued` follows.

## Token usage (0.32.0)

```sh
nexus usage                        # the last 7 days, in all and by model, project, agent, role and day
nexus usage --since today          # since midnight UTC
nexus usage --since 2026-10-01 --project acme --by model
nexus usage --since all --json     # the API's UsageReport
```

The control plane records every model call the agents of its threads make, one record per call, in its registry, so the counts outlive the pylon and the thread. Each record keeps the thread's project, its role, the agent (`claude` or `pi`), the model, when the call was made, and its input, output, cache-write and cache-read tokens. A thread's role is `reviewer` or `check` for a thread the review loop started, `builder` for one a person started from a tailnet node, and `other` for the rest.

`usage` prints the tokens spent since `--since`, in all and by each breakdown. `--since` is `today` (since midnight UTC), `7d` or `30d` (today and the 6 or 29 UTC days before it), `all`, or the UTC day to start at, such as `2026-10-01`, and `7d` when it is not given, as the dashboard's Usage page defaults to. `--project P` counts only that project's threads. `--by` prints only that breakdown, or those named, comma-separated, and every one when it is not given: `model`, `project`, `kind` (the agent), `role`, and `day`, a UTC day. The text starts with the period and when counting started, then the backfill's line, then a table of the totals, then a table per breakdown, each count shortened, such as `1.2M`. With `--json` it prints the report as the API answers it, every count exact:

```ts
interface UsageTotals { input: number; output: number; cacheWrite: number; cacheRead: number; total: number; calls: number }
interface UsageReport {
  since: number | null;        // the start of the period's first UTC day in Unix milliseconds, or null for all of it
  countingSince: number;       // when this registry started counting
  project: string | null;
  thread: string | null;       // the route takes thread=T too, which the CLI does not send
  total: UsageTotals;
  by: { model?: UsageRow[]; project?: UsageRow[]; kind?: UsageRow[]; role?: UsageRow[]; day?: UsageRow[] };
  backfill: UsageBackfill;     // since 0.33.0, as Usage backfill describes
}
type UsageRow = UsageTotals & { key: string };   // biggest total first, except days, newest first
```

`total` is the sum of the four token counts. An unknown `--since` or `--by` fails with exit code 64, the API's 400. A control plane older than 0.32.0 has no such route, and `usage` fails with exit code 4.

Counting started when the control plane first ran with it, which `countingSince` holds. The calls of threads that ran then were counted from the transcripts their pylons had, and an archived thread's once the [usage backfill](#usage-backfill-0330) reads its pylon. Threads deleted before then are not counted, as their Claude and pi transcripts went with their pylons, except for the Nexus agent's calls, which the harness keeps for every thread. The summaries the Nexus agent's compactions write, and model calls its tools make, are not counted. [Token usage records](data-model.md#token-usage-records) describes what is read and when.

The dashboard shows the same at `/usage`, linked from its sidebar: the period (today, 7 days, 30 days or all), a project or all of them, the totals and each breakdown, every count with its exact number in its title. A thread page's Pylon pane shows the thread's own tokens, of all time.

## Usage backfill (0.33.0)

```sh
nexus usage backfill --dry-run     # the archived threads a start would read, with why a run before skipped one
nexus usage backfill               # start reading them, one pylon at a time
nexus usage                        # its line says how far it got
nexus usage backfill --stop        # stop, and let the pylon it holds pause
```

An archived thread's pylon is paused, and counting reads a pylon only while it runs, so the calls of a thread archived before counting started, or after its last read, are left on its disk. The backfill reads them: it wakes each archived thread's pylon in turn without bringing its sessions back, so no agent starts, reads every Claude Code transcript and pi session on its disk from the start, records the calls under the same call IDs as counting does, so none counts twice, and lets the pylon pause again before it wakes the next. One pylon is up at a time, on any node. It waits, and says why, while the pylon's node is offline, runs a probe too old to wake a pylon without its sessions, runs a job, or would have less memory left with the pylon up than the largest project's pylon needs, so a start always fits. The thread stays archived the whole time: nothing reviews it, watches its pull requests or messages its agent, and no human activity is recorded.

`usage backfill` starts a run, which needs a deployer, as `deploy` does: any other caller fails with exit code 3, the API's 403. The run lists every archived thread with a pylon that no run has read, and a thread a run skipped is read again. A start while one runs changes nothing. `--stop` stops the run, which needs a deployer too, and the pylon it holds pauses. A thread whose read the stop cut short is read by the next start. `--dry-run` prints the threads a start would read, one line each with the thread, its project, its node and its title, and under one a run skipped, `skipped before:` and why. Each prints the run's state as `usage` does. `--dry-run` with `--stop` fails with exit code 64. The run lives in the registry, so a control plane that restarts or deploys mid-run goes on with the pylon it held. A control plane older than 0.33.0 has no such route, and `usage backfill` fails with exit code 4. Its `usage` report has no `backfill`, and `usage` prints no backfill line.

A thread is skipped, with the reason, when it was unarchived or deleted before or while it was read, its pylon failed or its node holds no disk for it, its wake failed, which never fails the pylon, its pylon did not run within 10 minutes, or the read failed. The run waits up to 10 minutes for each pylon it read to pause.

The backfill's line in `usage`, and what `usage backfill` prints:

```
Backfill: not run. A deployer runs `nexus usage backfill` to read archived threads' pylons.
Backfill: running, 3 of 10 threads read, recovered 412 calls and 21.5M tokens. It reads the pylon of th-0a3f4ba836c1.
Backfill: running, 3 of 10 threads read, recovered 412 calls and 21.5M tokens. It waits: rj-firebat is busy with a job.
Backfill: stopped at 3 of 10 threads read, recovered 412 calls and 21.5M tokens.
Backfill: done at 2026-10-28 09:12 UTC, 10 of 10 threads read, 1 skipped, recovered 1234 calls and 56M tokens.
Skipped:
th-5c1e0b2d9a77  Old spike  rj-firebat holds no disk for its pylon
```

A thread is read once it is done or skipped, and `recovered` counts the calls no read had counted before and the tokens they added. A stopped or finished run lists what it skipped. With `--json` the commands print the API's shapes:

```ts
type UsageBackfill =
  | { state: "never" }
  | {
    state: "running" | "stopped" | "done";
    startedAt: number;
    finishedAt: number | null;   // when it stopped or finished
    current: { thread: string; phase: "reading" | "pausing"; since: number } | null;   // the pylon it holds: woken to be read, or read and pausing
    waiting: string | null;      // why it waits before the next pylon
    read: number;                // threads done or skipped
    of: number;                  // every thread a run listed
    recovered: { calls: number; tokens: number };
    skipped: BackfillThread[];
  };
interface BackfillThread { thread: string; title: string; state: "pending" | "done" | "skipped"; reason: string | null; calls: number; tokens: number; at: number | null }
interface BackfillPlanRow { thread: string; project: string; node: string; title: string; reason: string | null }   // reason: why a run before skipped it
```

The dashboard's Usage page says the same under its totals, with a table of the skipped threads and why. A pylon the backfill reads shows `reading` as its desired phase. [Token usage records](data-model.md#token-usage-records) describes the records.
