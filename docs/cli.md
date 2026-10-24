# The Mac nexus CLI

`nexus` runs on a Mac and drives the control plane's API: add projects, list threads, start one, message it, watch it, and archive or delete it. People use it at a shell. The Claude Code mod and the pi extension shell out to it, so this page is their contract. The code is [`src/cli/nexus.ts`](../src/cli/nexus.ts), and its transport is [`src/cli/transport.ts`](../src/cli/transport.ts). This page describes version 0.4.0, which `nexus --version` prints. Version 0.4.0 added `project add` and its route, `POST /v1/projects`. Version 0.3.0 added `unpreview` and its route, `DELETE /v1/threads/<thread>/previews/<port>`. Version 0.2.0 added `ports`, `preview`, `Preview.url`, `ThreadDetail.ports` and the `ports` of a watch `state`.

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
| `conversation <thread>` | `GET /v1/threads/<thread>/conversation` | `ConversationView` |
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
| `projects` | `GET /v1/projects` | `Project[]` |
| `project add <id> <repo-url> --node N [--branch B] [--cpus n] [--memory GiB] [--disk GiB] [--allow-host HOST]... [--login claude\|chatgpt]...` | `POST /v1/projects`, and without `--node` `GET /v1/nodes` | `Project`, the project that was added |
| `nodes` | `GET /v1/nodes` | `NodeSummary[]` |

These commands need more explanation:

- `start` without `--title` takes the title from the first non-empty line of `--message`, cut to 80 characters. It needs at least one of the two. If the thread starts but its first message fails, the command fails with the message's exit code, and the error names the thread that was started.
- `send` joins its words with single spaces. By default the message is a follow-up, so a busy run takes it after its current turn. With `--steer`, the message joins the current run after its current tool round. The API treats a second send with the same `--request-id` as the same message. A caller that retries a send should pass its own request ID, such as `msg:<uuid>`. Without one, each run mints a new ID.
- `project add` adds a project whose threads clone `<repo-url>` and boot on node `N` unless `start --node` picks another. It sends this `Project`: `defaultBranch` is `--branch`, or `main`. `resources` is `{ cpus, memoryGiB, diskGiB }` from `--cpus`, `--memory` and `--disk`, or 2, 4 and 10. `allowedHosts` holds each `--allow-host`, and `logins` each `--login`, in the order given. `secrets` is `[]` and `preSetup` is null, which only the API can set. Without `--json` it prints `Added project <id> (<repo-url>) on <node>`. `--node` is required, and without it the command fails with exit code 64 and names the nodes `GET /v1/nodes` lists, or names none when that request fails. A project that exists fails with exit code 5. A node the control plane does not know, an ID that is not lowercase letters, digits and hyphens starting with a letter or digit, up to 63 characters, an `https://` URL that does not parse, or a login other than `claude` or `chatgpt` fails with exit code 64. The API accepts any other non-empty `<repo-url>`, such as an SSH one. A project cannot be changed or removed from the CLI.
- `retry` runs a conversation's parked tasks again. `retry-pylon` clears a failed pylon so that the planner boots it again.
- `wake` records human activity, so a paused pylon is wanted running.
- `ports` lists the TCP ports that something in the pylon listens on and that a preview can reach, as the pylon's node last reported them. The node reads them every 10 seconds, so a server the agent just started shows within about that long. A port is listed whether or not it has a preview, and whatever started it: a declared service, an ad hoc one, or a process the agent ran itself. Nexus's own listeners, today only sshd on port 22, are left out. "A preview can reach" means bound to 127.0.0.1, 0.0.0.0 or `::`, or to the IPv4-mapped form of 127.0.0.1 or 0.0.0.0, because the preview connects to the pylon's 127.0.0.1. A server bound only to `::1` or to another loopback address such as 127.0.0.2 is not listed, and cannot be previewed: Gondolin's ingress always connects over IPv4 to 127.0.0.1, and offers no way to choose another address. This catches dev servers that bind `localhost` where it resolves to `::1` first, as Vite and other Node servers can on Node 17 and later. Bind such a server to 0.0.0.0 or 127.0.0.1, for example `vite --host 127.0.0.1`. When `ports` lists no port, its text output gives this advice.
- `preview` publishes a port as a preview, as `nexus preview <port>` does inside the pylon, and prints the port's `Preview`. The port need not listen yet. Asking again for the same port prints the same preview. A port that a declared or ad hoc service owns is previewed under that service, and a service without a preview is refused with exit code 1. Any other port is previewed as the service `port-<port>`, except Nexus's own, which is refused with exit code 64. A declared or ad hoc service's preview stays published for the thread's life, and a linked port's until `unpreview`. Either is open to every device on the home tailnet, and keeps its URL across pauses. After a wake, a process the agent started by hand must be started again before the URL answers. Previewing is human activity, so a paused pylon is woken, but the request itself needs the pylon running and fails with exit code 5 until it is. An archived or deleted thread fails with exit code 5, and a node the control plane cannot reach fails with exit code 1.
- `preview` prints the URL at once, but tailscale serves it only after the control plane's next pass publishes it, usually within seconds. With `--wait` the command polls once a second until the port's entry in `ports` has a preview whose `ready` is true, and prints that preview. Then the port listens in the pylon, and the node publishes and has warmed the URL. It fails with exit code 1 after 120 seconds.
- `unpreview` stops publishing a port that `preview` published, as `nexus unpreview <port>` does inside the pylon. It unlinks the port in the pylon and then drops its preview, so once it exits 0 the thread's `previews` leave it out, the port's entry in `ports` has `preview: null`, and the next `state` of a watch shows that. The pylon keeps the port unlinked across pauses, wakes and restarts of the probe or the control plane, and `preview` publishes it again, possibly on another https port. A port with no linked preview succeeds, so the command is safe to repeat. A port whose preview a declared or ad hoc service owns is refused with exit code 1: the API answers 422, and its `error` is the pylon's reason alone, which names the service, because only the service's declaration can drop that preview. So is a port whose name `port-<port>` a service holds. Nexus's own ports and anything that is not a port from 1 to 65535 fail with exit code 64. An archived or deleted thread fails with exit code 5, and a node the control plane cannot reach fails with exit code 1.
- `unpreview` needs the pylon running, because the pylon holds the link. Unpublishing is human activity, so the first try wakes a paused pylon, and the command tries again once a second until the pylon runs. It fails with exit code 1 after 120 seconds.
- Once `unpreview` exits 0, nothing reaches the app through the URL: the node's preview gateway has stopped routing it and answers 404 `no preview is published on <host>` itself, to a browser too. Tailscale stops serving the URL, after which a new connection to it is refused, only once the control plane's next pass publishes the previews without it, usually within a few seconds. The command does not wait for that pass.

The shapes are TypeScript types. `Thread` and `Preview` are in [`src/control/registry.ts`](../src/control/registry.ts). `ThreadDetail`, `ListeningPort` and `NodeSummary` are in [`src/control/api.ts`](../src/control/api.ts). `Project` is in [`src/project.ts`](../src/project.ts). `ConversationView`, `EntryRecord`, `LiveState` and `InboxState` come from `@earendil-works/pi-durable`. Times in `Thread` are Unix milliseconds, and the observation times are ISO strings. A consumer must ignore fields it does not know.

The previews and ports in `ThreadDetail` have these shapes:

```ts
type Preview = {
  pylon: string;      // the pylon's ID
  service: string;    // the service it previews: a declared or ad hoc service, or port-<port> for a linked port
  httpsPort: number;  // the https port on the pylon's node, fixed for the thread's life
  ready: boolean;     // the node publishes it and warmed its URL. It says nothing about the pylon answering
  url: string;        // https://<node's MagicDNS name>:<httpsPort>/. Use it as it is rather than building it
};
type ListeningPort = {
  port: number;              // a TCP port that a preview can reach in the pylon
  service: string | null;    // the service that owns the port, or null for a process no service runs
  preview: Preview | null;   // that service's preview, or null while it has none
};
// In ThreadDetail:
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
| 4 | `not-found` | 404. No such thread or project |
| 5 | `conflict` | 409. The thread's state forbids the action, for example a message to an archived thread, or a project with that ID exists |
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
