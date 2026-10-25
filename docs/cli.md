# The Mac nexus CLI

`nexus` runs on a Mac and drives the control plane's API: add projects, list threads, start one, message it, watch it, and archive or delete it. People use it at a shell. The Claude Code mod and the pi extension shell out to it, so this page is their contract. The code is [`src/cli/nexus.ts`](../src/cli/nexus.ts), and its transport is [`src/cli/transport.ts`](../src/cli/transport.ts). This page describes version 0.8.0, which `nexus --version` prints. Version 0.8.0 added `Session.id`, `Session.state` and `Session.message`, so a paused pylon lists the sessions its wake brings back and a session its last wake failed to bring back shows why, and `session close` now takes a session's ID, refuses a paused session, fails on a pane that is not open or that runs another session than the one listed there, and no longer tries again. Version 0.7.0 added scratch projects, whose `Project.repoUrl` is null, `project add --scratch` and `--secret`, and a null `Base.commit` where the base is the empty tree. Version 0.6.0 added `files`, `changes` and `diff`, their routes `GET /v1/threads/<thread>/files`, `GET /v1/threads/<thread>/changes` and `GET /v1/threads/<thread>/diff`, `Listing`, `Changes` and `Diff`, and the route `GET /v1/threads/<thread>/files/content`, which the CLI does not use. Version 0.5.0 added `session open`, `session close` and `attach`, the routes `POST /v1/threads/<thread>/sessions` and `DELETE /v1/threads/<thread>/sessions/<pane>`, `OpenedSession`, `Session.title`, `Preview.failed`, and the attach settings: `NEXUS_ATTACH`, and `"ssh"` and `"attach"` in the config file. Version 0.4.0 added `project add` and its route, `POST /v1/projects`. Version 0.3.0 added `unpreview` and its route, `DELETE /v1/threads/<thread>/previews/<port>`. Version 0.2.0 added `ports`, `preview`, `Preview.url`, `ThreadDetail.ports` and the `ports` of a watch `state`.

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

An empty environment variable counts as unset. The config file is a JSON object with only those two optional keys and `"ssh"` and `"attach"`, described next. Any other key fails the command with exit code 64.

### Reaching a node for `attach`

`attach` opens a terminal on a pylon, which only its node reaches, so it runs `ssh` to that node. It finds the node in the thread's `pylon.node`, and the node's MagicDNS name in its `tailnetHost` from `GET /v1/nodes`. By default it runs:

```sh
ssh -t -o 'ProxyCommand=nc -X 5 -x <proxy> %h %p' <tailnetHost> nexus-attach <pylon>
```

`<proxy>` is the CLI's SOCKS5 proxy, from the table above, and with `--socks none` the `ProxyCommand` is left out. The SSH user, keys and any other options come from your `~/.ssh/config`, which can match the node's MagicDNS name.

When your account on a node has another name, or your ssh config knows the node by an alias, give `attach` the node's destination in `~/.config/nexus/cli.json`. `"ssh"` maps a node's name, as `nexus nodes` lists it, to the destination ssh connects to in place of its `tailnetHost`, such as `user@host` or an alias. It still goes through the proxy. A destination that starts with `-` or holds a space fails every command with exit code 64. For example:

```json
{ "ssh": { "rj-firebat": "ramtinj@rj-firebat.tailc817d3.ts.net" } }
``` A node with Tailscale SSH may ask you to approve the login in a browser first. `nexus-attach` is installed on every node by `deploy/install-probe.sh`.

To reach a node any other way, set `NEXUS_ATTACH` or `"attach"` in `~/.config/nexus/cli.json`, in that order. Either one wins over `"ssh"`. It is a command that `attach` runs with `sh -c` instead of ssh, with `NEXUS_THREAD`, `NEXUS_PYLON`, `NEXUS_NODE` and `NEXUS_NODE_HOST` in its environment. For example:

```sh
NEXUS_ATTACH='ssh -t home-$NEXUS_NODE nexus-attach $NEXUS_PYLON' nexus attach th-0123456789ab
# A Docker pylon on this Mac, such as the verify-nexus stack's:
NEXUS_ATTACH='docker exec -it $NEXUS_PYLON herdr --session nexus' nexus attach th-0123456789ab
```

## Commands

Every command takes `--json`, `--url` and `--socks`. `<thread>` is a thread ID such as `th-0123456789ab`.

With `--json`, a command prints one JSON value on stdout, pretty-printed. The value is the API's reply, apart from the exceptions noted in the table. Without `--json`, output is plain text for people. Its format is not part of this contract.

| Command | Route | `--json` prints |
|---|---|---|
| `threads [--project P] [--all]` | `GET /v1/threads[?project=P]` | `ThreadRow[]`: each `Thread` with `desired` and `pylon: { node, actualState, failed }`, as in `ThreadDetail`. Deleted threads are left out unless `--all` is given |
| `show <thread>` | `GET /v1/threads/<thread>` | `ThreadDetail`. Its `desired` is what the planner wants of the pylon now: `running`, `paused` or `deleted`. Its `attach` is the command that attaches to the pylon's Herdr sessions from a shell in the pylon |
| `ports <thread>` | `GET /v1/threads/<thread>` | `ListeningPort[] \| null`, the detail's `ports` |
| `preview <thread> <port> [--wait]` | `POST /v1/threads/<thread>/previews` with `{"port": number}`, then with `--wait` polls `GET /v1/threads/<thread>` | `Preview`, the port's preview |
| `unpreview <thread> <port>` | `DELETE /v1/threads/<thread>/previews/<port>` with `{}` and its `content-length`, which answers 204. Node's `http` module frames a DELETE's body only with an explicit length. While the pylon is not running, it tries again once a second | `null` |
| `files <thread> [path]` | `GET /v1/threads/<thread>/files?path=<path>`. While the pylon is not running, it tries again once a second | `Listing`, the directory's entries |
| `changes <thread> [--uncommitted]` | `GET /v1/threads/<thread>/changes?base=start`, or `base=head` with `--uncommitted`. While the pylon is not running, it tries again once a second | `Changes` |
| `diff <thread> [path...] [--uncommitted]` | `GET /v1/threads/<thread>/diff?base=start&path=<path>...`, or `base=head` with `--uncommitted`. While the pylon is not running, it tries again once a second | `Diff` |
| `conversation <thread>` | `GET /v1/threads/<thread>/conversation` | `ConversationView` |
| `session open <thread> [--harness claude-code\|pi\|shell] [--title T]` | `POST /v1/threads/<thread>/sessions` with `{"harness"?: string, "title"?: string}`, which answers 201. While the pylon is not running, it tries again once a second | `OpenedSession`, the session it opened |
| `session close <thread> <pane\|id>` | `DELETE /v1/threads/<thread>/sessions/<id>` with `{}`, which answers 204. It does not try again | `null` |
| `attach <thread>` | `GET /v1/threads/<thread>`, `POST .../activity` and `GET /v1/nodes`, then `ssh` to the pylon's node | Nothing. The terminal is the session's |
| `start --project P [--title T] [--message M] [--node N] [--branch B] [--commit C]` | `POST /v1/threads`, then `POST .../messages` when `--message` is given | `Thread`, the thread that was started |
| `send <thread> <text...> [--steer] [--request-id ID]` | `POST /v1/threads/<thread>/messages` | `{ "submission": number }` |
| `watch <thread> [--interval MS]` | Follows `GET /v1/threads/<thread>/events` and polls `GET /v1/threads/<thread>` | A stream of JSON lines, described below |
| `abort <thread>` | `POST /v1/threads/<thread>/abort` | `null` |
| `retry <thread>` | `POST /v1/threads/<thread>/retry` | `null` |
| `retry-pylon <thread>` | `POST /v1/threads/<thread>/pylon/retry` | `null` |
| `wake <thread>` | `POST /v1/threads/<thread>/activity` with `{"kind":"human"}` | `null` |
| `archive <thread>` | `POST /v1/threads/<thread>/archive` | `Thread` |
| `unarchive <thread>` | `POST /v1/threads/<thread>/unarchive` | `Thread` |
| `delete <thread>` | `DELETE /v1/threads/<thread>` | `Thread`, with status `deleted` |
| `projects` | `GET /v1/projects` | `Project[]`. A scratch project's `repoUrl` is null |
| `project add <id> (<repo-url> \| --scratch) --node N [--branch B] [--cpus n] [--memory GiB] [--disk GiB] [--allow-host HOST]... [--login claude\|chatgpt]... [--secret NAME:HOST[,HOST]...]...` | `POST /v1/projects` | `Project`, the project that was added |
| `nodes` | `GET /v1/nodes` | `NodeSummary[]` |

These commands need more explanation:

- `start` without `--title` takes the title from the first non-empty line of `--message`, trimmed. A line longer than 80 characters keeps its first 80 and gets `...` appended, so such a title is 83 characters. It needs at least one of the two. If the thread starts but its first message fails, the command fails with the message's exit code, and the error names the thread that was started.
- `start --commit` on a scratch project fails with exit code 64, because its repository has no commit to check out. `--branch` names the empty repository's first branch instead.
- `send` joins its words with single spaces. By default the message is a follow-up, so a busy run takes it after its current turn. With `--steer`, the message joins the current run after its current tool round. The API treats a second send with the same `--request-id` as the same message. A caller that retries a send should pass its own request ID, such as `msg:<uuid>`. Without one, each run mints a new ID.
- `project add` adds a project whose threads clone `<repo-url>` and boot on node `N` unless `start --node` picks another. With `--scratch` instead of a URL, the project has no repository: each thread's pylon starts from `git init` on the branch, nothing is fetched, and nothing in the pylon is kept once the thread is deleted unless its agent pushed it somewhere. It sends this `Project`: `repoUrl` is `<repo-url>`, or null with `--scratch`. `defaultBranch` is `--branch`, or `main`. `resources` is `{ cpus, memoryGiB, diskGiB }` from `--cpus`, `--memory` and `--disk`, or 2, 4 and 10. `allowedHosts` holds each `--allow-host`, `logins` each `--login`, and `secrets` each `--secret`, in the order given. `preSetup` is null, which only the API can set. Without `--json` it prints `Added project <id> (<repo-url>) on <node>`, or `Added scratch project <id> on <node>`. `--node` is required, and exactly one of `<repo-url>` and `--scratch` is too. Without them the command fails with exit code 64 before it sends any request, so a forgotten URL never makes a scratch project. `nexus nodes` lists the nodes. A project that exists fails with exit code 5. A node the control plane does not know, an ID that is not lowercase letters, digits and hyphens starting with a letter or digit, up to 63 characters, an `https://` URL that does not parse, or a login other than `claude` or `chatgpt` fails with exit code 64. The API accepts any other non-empty `<repo-url>`, such as an SSH one. A project cannot be changed or removed from the CLI.
- `--secret NAME:HOST[,HOST]` grants the secret `NAME` to those hosts, such as `--secret GH_TOKEN:api.github.com,github.com`, which lets the project's agents create GitHub repositories with `gh` and push to them. The value is never sent: it lives in each node's `/etc/nexus/secrets.env`, as [deploy/README.md](../deploy/README.md) describes, and a pylon on a node that lacks it fails to boot. The name is upper-case letters, digits and underscores, not starting with a digit, and each host a lower-case hostname with a dot. Anything else, such as `GH_TOKEN=<token>` pasted by mistake, fails with exit code 64 before any request, and the error does not repeat it. Each host joins the pylon's allowlist.
- `session open` opens a session in the pylon: a Herdr workspace in the checkout, `/home/user/workspace/repo`, labelled with the title, with the harness's agent in it. The harness is `claude-code` by default, and the title is the harness's name by default, at most 80 characters. The command returns once the agent is ready or waits for its human, such as Claude Code at its login or trust screen, so a session that needs `/login` opens and waits for it. Starting an agent can take most of a minute, so the command waits up to 120 seconds for the reply, rather than the usual 30. Opening is human activity, so a paused pylon is woken, and the command tries again once a second until the pylon runs, failing with exit code 1 after 120 seconds. An archived or deleted thread fails with exit code 5, a harness other than the three with exit code 64, and a node the control plane cannot reach with exit code 1. The session is listed in the thread's `sessions` within moments, because the node reads its sessions again at once. Without `--json` it prints `Opened <harness> session "<title>" in pane <pane> of <thread>.` and how to attach.
- `session close` closes a session by its `id` from the thread's `sessions`, which is its pane, `herdrPane`, for every session in one. Closing a pane ends its agent. A `failed` session in no pane has an `id` of the form `failed-<hash>`, and closing it drops it from the pylon, so no wake tries it again. A `paused` session fails with exit code 5 without waking the pylon: it comes back when the pylon wakes, or when `nexus unarchive` wakes an archived thread's, and can be closed once it runs. A pane that is not open fails with exit code 4, because a wake can move a session to another pane, so a pane from before it may name no session or another one: read `sessions` again. So does a pane that runs another session than the one `sessions` last listed in it, which is left open. A pylon that is not running fails with exit code 5, and the request wakes it, so ask again once it runs. The command never tries again on its own. Without `--json` it prints `Closed session <id> of <thread>.`
- `attach` gives this terminal to the pylon's Herdr session, `herdr --session nexus`, in which every session is a workspace, until you detach from Herdr. It needs a terminal. It records human activity, which wakes a paused pylon, polls once a second until the pylon runs, and then runs `ssh` to the pylon's node, as [Reaching a node for `attach`](#reaching-a-node-for-attach) describes. An archived or deleted thread fails with exit code 5 before anything else, a failed pylon with exit code 1, and a pylon that does not run within 120 seconds with exit code 1. When ssh or the configured command exits with any code other than 0, `attach` fails with exit code 1, and a failed ssh's message points to `"ssh"` and `NEXUS_ATTACH`. On the node, `nexus-attach` asks the pylon's controller for the guest's sshd and connects to it as `user`, or uses `docker exec` for a Docker pylon. If no Herdr server runs yet, it starts one as `session open` does. While a terminal stays attached, the pylon counts a human as present, so the 20 minutes without a human that pause a pylon do not run out. Close the terminal, or detach from Herdr, to let the pylon pause. An archived thread's pylon pauses all the same, which ends the terminal.
- To log Claude Code in, run `nexus session open <thread>`, then `nexus attach <thread>`, pick the session's workspace in Herdr, and type `/login` in Claude Code. The project's threads need `claude` among its `logins`, which only a new project can have: `nexus project add ... --login claude`. Pick the device-code or paste login, because a browser callback cannot reach the pylon. The login lives on the pylon's disk, so it survives pauses but not the thread. Every Claude Code session starts with a session ID of its own, so after an archive and an unarchive it comes back with `claude --resume <id>` and its conversation, whether or not it was logged in when it opened.
- `retry` runs a conversation's parked tasks again. `retry-pylon` clears a failed pylon so that the planner boots it again.
- `wake` records human activity, so a paused pylon is wanted running.
- `ports` lists the TCP ports that something in the pylon listens on and that a preview can reach, as the pylon's node last reported them. The node reads them every 10 seconds, so a server the agent just started shows within about that long. A port is listed whether or not it has a preview, and whatever started it: a declared service, an ad hoc one, or a process the agent ran itself. Nexus's own listeners, sshd on port 22 and the preview relay on ports 700 to 799, are left out. "A preview can reach" means bound to 127.0.0.1, 0.0.0.0, `::` or `::1`, or to the IPv4-mapped form of 127.0.0.1 or 0.0.0.0. Gondolin's ingress always connects over IPv4 to 127.0.0.1 and offers no way to choose another address, so every preview goes through a relay in the pylon, which listens on one of its own ports and connects to the server's port on 127.0.0.1, or on `::1` when nothing listens there. A server bound only to `::1`, as Vite and other Node servers that bind `localhost` are on Node 17 and later, is therefore listed and previewed like any other. The relay never holds the server's port, so a server may bind it again, or move it to another address, while its preview stays published. A server bound to another loopback address such as 127.0.0.2, or to any other address, is not listed and cannot be previewed.
- `preview` publishes a port as a preview, as `nexus preview <port>` does inside the pylon, and prints the port's `Preview`. The port need not listen yet. Asking again for the same port prints the same preview. A port that a declared or ad hoc service owns is previewed under that service, and a service without a preview is refused with exit code 1. Any other port is previewed as the service `port-<port>`, except Nexus's own, which is refused with exit code 64. A declared or ad hoc service's preview stays published for the thread's life, and a linked port's until `unpreview`. Either is open to every device on the home tailnet, and keeps its URL across pauses. After a wake, a process the agent started by hand must be started again before the URL answers. Previewing is human activity, so a paused pylon is woken, but the request itself needs the pylon running and fails with exit code 5 until it is. An archived or deleted thread fails with exit code 5, and a node the control plane cannot reach fails with exit code 1.
- `preview` prints the URL at once, but tailscale serves it only after the control plane's next pass publishes it, usually within seconds. With `--wait` the command polls once a second until the port's entry in `ports` has a preview whose `ready` is true, and prints that preview. Then the port listens in the pylon, its service, if the node reports one, is ready, and the node publishes and has warmed the URL. It fails with exit code 1 after 120 seconds.
- A preview whose service the pylon's node reports starting, stopped or failed is not ready, though the node may still publish its URL, which then answers 502. A failed one's `failed` says why, and the text of `show`, `ports` and `preview` says so too. `--wait` keeps polling, because a service that starts, or one restarted in the pylon, makes the preview ready.
- `unpreview` stops publishing a port that `preview` published, as `nexus unpreview <port>` does inside the pylon. It unlinks the port in the pylon and then drops its preview, so once it exits 0 the thread's `previews` leave it out, the port's entry in `ports` has `preview: null`, and the next `state` of a watch shows that. The pylon keeps the port unlinked across pauses, wakes and restarts of the probe or the control plane, and `preview` publishes it again, possibly on another https port. A port with no linked preview succeeds, so the command is safe to repeat. A port whose preview a declared or ad hoc service owns is refused with exit code 1: the API answers 422, and its `error` is the pylon's reason alone, which names the service, because only the service's declaration can drop that preview. So is a port whose name `port-<port>` a service holds. Nexus's own ports and anything that is not a port from 1 to 65535 fail with exit code 64. An archived or deleted thread fails with exit code 5, and a node the control plane cannot reach fails with exit code 1.
- `files`, `changes` and `diff` read the pylon's checkout, `/home/user/workspace/repo`, as the Files and Changes views of a client do. Paths are relative to the checkout, and one that leaves it, through `..` or a symlink, fails with exit code 64, so a client never shows the pylon's Claude Code and pi logins by mistake. The reads run in the pylon, so this check is no boundary against the pylon itself, whose agent can read those files anyway and could swap a checked path for a symlink. `files` lists a directory, the checkout itself by default, sorted by name, with each file's size, at most 2000 entries. A path that does not exist fails with exit code 4.
- `changes` lists the files that differ from the commit the pylon booted at, so the agent's commits show as well as its uncommitted work. With `--uncommitted` they differ from HEAD instead. Both compare the working tree, untracked files included and ignored ones left out, without touching the pylon's own git index. A rename shows as one, with its `oldPath`. A binary file's `additions` and `deletions` are null. At most 3000 files are listed, and `truncated` says whether there were more. The pylon records what it booted at as `refs/nexus/base` in the checkout, on its first boot. A scratch project's pylon boots an empty repository, which has no commit, so it records the empty tree: every file shows as added, before the agent's first commit and after it, and `base.commit` is null. Before the first commit, `--uncommitted` compares with the empty tree too, with a null `base.commit`. A pylon that booted before Nexus recorded it has none, so `changes` without `--uncommitted` fails with exit code 1, the API's 422, and the message says to ask for the changes since HEAD instead.
- `diff` prints the unified diff from the same base, of the whole tree or of the paths given. Each path is literal, never a glob. A renamed file needs both its old and its new path, or it shows as added. The diff stops at 4 MiB, and `truncated` says whether it did. Reading a large tree can take the pylon a while, so these commands wait up to 120 seconds for the reply, rather than the usual 30.
- Like `preview`, reading the checkout is human activity, so the first try wakes a paused pylon, and the command tries again once a second until the pylon runs, failing with exit code 1 after 120 seconds. An archived or deleted thread fails with exit code 5. A read the pylon does not finish within 90 seconds fails with exit code 1, the API's 504. So does one asked for while 32 reads are open on the control plane, the API's 503, because a read that passed its deadline stays open until the pylon's process ends. Paths too long for one request, about 8 KiB once URL-encoded, fail with exit code 64.
- `GET /v1/threads/<thread>/files/content?path=<path>` serves a file's bytes, at most 10 MiB, for a client to show. A larger file is refused with 413, and a directory with 400. PNG, JPEG, GIF and WebP files are served as images. Anything else is served as `text/plain; charset=utf-8` when it is UTF-8 without a NUL byte, and as `application/octet-stream` otherwise, with `x-content-type-options: nosniff` and a sandboxing `content-security-policy`, so a repository's HTML or SVG never runs as a page of the API's origin, which the dashboard shares.
- `unpreview` needs the pylon running, because the pylon holds the link. Unpublishing is human activity, so the first try wakes a paused pylon, and the command tries again once a second until the pylon runs. It fails with exit code 1 after 120 seconds.
- Once `unpreview` exits 0, nothing reaches the app through the URL: the node's preview gateway has stopped routing it and answers 404 `no preview is published on <host>` itself, to a browser too. Tailscale stops serving the URL, after which a new connection to it is refused, only once the control plane's next pass publishes the previews without it, usually within a few seconds. The command does not wait for that pass.

The shapes are TypeScript types. `Thread`, `Session` and `Preview` are in [`src/control/registry.ts`](../src/control/registry.ts). `Listing`, `Changes` and `Diff` are in [`src/checkout-files.ts`](../src/checkout-files.ts). `ThreadDetail`, `ListeningPort`, `OpenedSession` and `NodeSummary` are in [`src/control/api.ts`](../src/control/api.ts). `Project` is in [`src/project.ts`](../src/project.ts). `ConversationView`, `EntryRecord`, `LiveState` and `InboxState` come from `@earendil-works/pi-durable`. Times in `Thread` are Unix milliseconds, and the observation times are ISO strings. A consumer must ignore fields it does not know.

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
  | { state: "paused"; herdrPane: string | null; message: null }   // its pylon is paused, and its wake brings it back. herdrPane is the pane it had
  | { state: "failed"; herdrPane: string | null; message: string } // the last wake did not bring it back, and message says why. The next wake tries again.
);                                     // herdrPane is the pane it left behind, such as a shell its agent would not start in, or null
type OpenedSession = { herdrPane: string; harness: "claude-code" | "pi" | "shell"; title: string };  // what session open prints
type Preview = {
  pylon: string;      // the pylon's ID
  service: string;    // the service it previews: a declared or ad hoc service, or port-<port> for a linked port
  httpsPort: number;  // the https port on the pylon's node, fixed for the thread's life
  ready: boolean;     // the node publishes it and warmed its URL, and the running pylon's node does not report its service starting, stopped or failed
  failed: string | null; // why it cannot answer: the pylon's node last reported its service failed. Null otherwise, and while the pylon is not running
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
type Base = { kind: "start" | "head"; commit: string | null };  // start: what the pylon booted at. null where the base is the empty tree
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

The control plane serves the routes for recording images too. The CLI leaves them out, because only release tooling uses them.

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

`nexus watch <thread> --json` follows the thread's conversation as the control plane streams it, polls the rest of the thread every `--interval` milliseconds, 2000 by default, and prints one compact JSON object per line. Each object has a `type` and the `thread` ID.

The conversation streams from `GET /v1/threads/<thread>/events`, as server-sent events whose data is a `ViewFrame` from [`src/control/api.ts`](../src/control/api.ts). pi-durable commits an answer as it is written at most every 100 ms, and the output of a running tool on the same throttle, so `live` comes up to ten times a second while the agent writes. A change to the conversation prints within one commit, and a change to the pylon, its ports or the thread's status within one interval.

```ts
type RenderedEntry = { entry: EntryRecord; text: string };
type WatchEvent =
  | { type: "reset"; thread: string; entries: RenderedEntry[] }
  | { type: "entry"; thread: string; entry: EntryRecord; text: string }
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
- `error` reports that the control plane is unreachable or failing. The watch keeps polling, and opens a dropped stream again after 100 ms, then after twice as long each time it fails, up to the interval. An outage prints one `error` per distinct message, whether the poll or the stream failed with it. Once both work again, `state` is printed again, which means the control plane is back.
- The stream ends with exit code 0 after the `state` whose `status` is `deleted`, or at SIGINT, SIGTERM or SIGHUP, or when the reader closes the pipe, or when the process that started it has exited, noticed at the end of the poll and interval under way, so a consumer killed outright leaves no watch behind. An unknown thread exits 4, and a refusal exits 3, with the usual stderr line.
- A consumer must ignore event types and fields it does not know, so that later versions can add them.
