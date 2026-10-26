# A desktop app as Nexus's main interface

This page explores [the roadmap's item](../roadmap.md#next) on whether a desktop app becomes Nexus's main interface. Neither the client mods nor the web dashboard feels good enough as the place to work with threads. The page looks at what makes [t3code](https://github.com/pingdotgg/t3code) and [Jetline](https://github.com/MartinRybergLaude/jetline) work well, then weighs three ways forward. The person decides. Until then the roadmap item stays open.

Written on 2026-10-26 against Nexus at `a9a356c`, t3code at [`c58beff`](https://github.com/pingdotgg/t3code/tree/c58beff8102e179493d8aae66d5e44c3c8cd0f46) and Jetline at [`918fa86`](https://github.com/MartinRybergLaude/jetline/tree/918fa8656cab856eae29337399548d0b29527a1a).

## Recommendation: keep the web dashboard and close its gaps

Keep the dashboard as the place to work with threads, and build what it lacks: a terminal on the thread page, pushed updates instead of polling, highlighted diffs with review comments, and an installable window. Copy ideas, and MIT code where it fits, from t3code's web app. Don't fork t3code, and don't adapt t3code or Jetline to show Nexus threads. Leave a native desktop shell for later. Build one only if notifications must arrive when no dashboard window is open and Web Push can't deliver them.

The reasons, in short:

- **Neither app can reach a pylon.** t3code's server and Jetline's engine both own the checkout, the terminals and the agent process on the machine they run on. A Nexus thread's checkout and sessions are in a pylon that only the control plane reaches. Either app would need a layer that translates its whole client protocol into Nexus's API. That layer is most of the work of a new client, and it then has to keep pace with someone else's code.
- **The dashboard already speaks the API and has the hard parts.** It has attention and the seen marker, system notifications, the Claude worker's live conversation from [nexus#86](https://github.com/ramtinJ95/nexus/pull/86), Changes and Latest turn, and previews. It sits behind the same tailnet check as every route.
- **The terminal works from the dashboard today.** A browser terminal on the thread page attached to a pylon's Herdr session through the attach route. The socket opened under the dashboard's own Content Security Policy. Typing, output and resize all worked. xterm.js needs its WebGL renderer, or a CSP nonce, to draw under that policy. [The verification](../verification/desktop-app/README.md) has the script and the captures.
- **Most gaps are client work.** The dashboard's own roadmap items cover diffs, review comments, polish and HTTPS previews. The dashboard needs one API addition, events for pylon state, previews and a thread's lifecycle, so that it can stop polling. A JSON stream of a Claude worker's conversation and an interrupt for one are needed only by clients other than the dashboard.

The case against this recommendation is feel. t3code and Jetline feel fast because the client keeps a local copy of state that the server pushes to it, and because the terminal, the conversation and the diff share one window with a keyboard model. The dashboard renders HTML on the server and polls every 5 seconds. Closing that gap means more client code in the dashboard, and probably a build step for it. It does not need a new app.

## What the interface must have

The roadmap names five things. This table says what Nexus already provides for each, and what any client still lacks.

| Need | Nexus provides today | Missing |
|---|---|---|
| A real terminal on a pylon's sessions | `GET /v1/threads/<thread>/attach`, a WebSocket that [`src/attach-wire.ts`](../../src/attach-wire.ts) defines and [`src/control/attach.ts`](../../src/control/attach.ts) serves. The CLI uses it. The route admits a page from the dashboard's own origin, or a client that sends no `Origin`, such as the CLI or a desktop app's main process ([`api.ts`](../../src/control/api.ts) line 1041) | A terminal in any graphical client. The attach opens Herdr's own interface, with its list of workspaces, not one session's pane. Output has no byte offsets, so a client that reconnects gets a fresh screen from Herdr rather than the bytes it missed |
| The Claude worker's conversation | `GET /v1/threads/<thread>/conversation` returns the worker's transcript as JSON. `POST /v1/threads/<thread>/messages` types a message into its session. `GET /v1/events?follow=true` streams `session.*` events. The dashboard streams the conversation as HTML on `/threads/<thread>/stream` | A JSON stream of the transcript. `GET /v1/threads/<thread>/events` refuses a Claude worker thread with 409, because it has no harness conversation (`conversing` in [`api.ts`](../../src/control/api.ts)). An interrupt for a Claude worker. `POST /v1/threads/<thread>/abort` reaches only the harness |
| Diffs with review comments | `GET /v1/threads/<thread>/changes` and `/diff`, from the boot commit, from HEAD, or from the latest turn | Syntax highlighting and review comments, which are the roadmap items [Syntax-highlighted diffs](../roadmap.md#next) and [Review comments on the diff](../roadmap.md#next). A review goes to the agent as an ordinary message, so it needs no new route. GitHub review comments need the pull request watch to post them |
| Previews | The thread detail lists each preview with its tailnet HTTPS URL. `POST` and `DELETE /v1/threads/<thread>/previews` publish and unpublish a port | Every link over HTTPS, which is the roadmap item [Previews and ports over HTTPS](../roadmap.md#next). Showing a preview inside the dashboard, which its CSP forbids today (`default-src 'none'` with no `frame-src`, [`dashboard.ts`](../../src/control/dashboard.ts) line 107) |
| Native notifications | Attention on every thread row. The dashboard shows a system notification for a failed, parked or replied thread when its window is not focused and it is served over HTTPS ([design](../design.md#shared-attention-and-dashboard-notifications)) | A notification when no dashboard window is open. That takes Web Push or a native app that runs in the background |

## What makes t3code and Jetline work well

Both apps put the conversation, a terminal and the diff in one window, next to each other, and both keep the client's state current without polling. The details differ.

**t3code.** Its web app and server ran from source in a pylon, with a copy of this repository as a project and a real Claude turn on it. The captures are in [the verification folder](../verification/desktop-app/README.md).

- A turn's tool calls fold into one line, "Ran 2 commands, changed 1 file, and performed 3 other actions", which opens into one row per call ([capture](../verification/desktop-app/t3code-tool-calls.png)). The reply ends with a card of the files it changed and an **Open diff** button ([capture](../verification/desktop-app/t3code-conversation.png)).
- The diff opens beside the conversation and is scoped to the latest turn by default. It is rendered by [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs) 1.6.1, which is Apache-2.0 licensed and depends on Shiki. Click a line number, press **+**, type a note and press Ctrl+Enter. The note stays beside the line, and a chip such as "README.md L26" lands in the composer, so the next message carries it ([capture](../verification/desktop-app/t3code-diff-comment.png), [`AnnotatableCodeView.tsx`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/apps/web/src/components/diffs/AnnotatableCodeView.tsx)).
- The terminal is a drawer under the conversation, in the project's directory ([capture](../verification/desktop-app/t3code-terminal.png)). The server owns the PTYs and keeps 5,000 lines of history, so a client that reconnects gets the output back. The web app renders it with libghostty compiled to WASM ([terminal runtime](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/docs/internals/terminal-runtime.md)).
- Notifications use the web `Notification` API ([`ThreadNotificationCoordinator.tsx`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/apps/web/src/components/ThreadNotificationCoordinator.tsx) line 195). The Electron shell adds a dock badge ([`preload.ts`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/apps/desktop/src/preload.ts) line 88).
- One WebSocket carries typed RPC for everything. The client keeps a local copy of state that the server pushes to it.

**Jetline.** It is a macOS app, so this page relies on its source and README. It was not run.

- The terminal is first class. Each tab is an agent's own TUI or a shell, rendered by libghostty, with ⌘1 to ⌘9 for tabs and ⌘⇧ arrows to move between tabs and workspaces ([README](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/README.md)). The engine keeps 4 MB of each terminal's output under absolute byte offsets, so a client that reconnects asks for exactly what it missed ([`EngineTerminal.swift`](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/Sources/JetlineApp/Engine/EngineTerminal.swift)).
- In its default chat mode it drives `claude` through the stream-json control protocol and draws its own timeline, with the "Ran 2 commands, edited a file" summaries that the dashboard copied ([`ClaudeProvider.swift`](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/Sources/JetlineApp/Agents/Claude/ClaudeProvider.swift), [`ChatRowNodes.swift`](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/Sources/JetlineApp/Views/Chat/Timeline/ChatRowNodes.swift) line 188).
- The engine and the app are separate. A remote Linux machine runs `jetlined`, and the app reaches it over ssh or any command whose stdin and stdout carry the protocol ([`EngineConnection.swift`](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/Sources/JetlineApp/Client/EngineConnection.swift)). Its ports are forwarded to the same port on the Mac.
- It has no comments on diff lines, and no system notifications. When an agent needs attention and Jetline is not in front, it bounces the dock icon ([`AppState.swift`](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/Sources/JetlineApp/AppState.swift) line 361).

What the dashboard should take from both: the terminal next to the conversation, a diff that opens from the turn that made it, notes on diff lines that go to the composer, pushed state, and a keyboard model. None of these needs a native app.

## Option 1: build a Nexus app from t3code's code

Fork t3code, keep its web and Electron apps, and point them at Nexus.

**Why it is hard.** t3code's design rule is that "provider processes, terminals, Git, and project files belong to the server" ([architecture](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/docs/internals/overview.md)). Its remote modes change how a client reaches a server, "they do not introduce another execution model" ([remote architecture](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/docs/internals/remote.md)). Checkpoints, diffs, file reads and terminals all take a local `cwd`. A fork either keeps t3code's server and rewrites everything under it to reach a pylon through Nexus, or drops the server and rewrites the client's data layer against Nexus's API. The client's contract with its server has 203 RPC methods ([`rpc.ts`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/packages/contracts/src/rpc.ts)).

**Size.** The web app is about 265,000 lines of TypeScript without tests, and the shared client runtime is about 45,000 more. It uses Effect 4, Node 26.12.1, pnpm 12 and Vite+, and the desktop app uses Electron 44.9.3. Upstream's latest commit refers to pull request #25163. Its [contributing guide](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/CONTRIBUTING.md) says it is "not actively seeking outside contributions", so a fork stays a fork.

**Steps, each about one PR, most of them large:**

1. Fork and strip the providers Nexus does not use, the mobile app, the marketing site and the source-control integrations other than GitHub.
2. Replace the server's thread and project model with Nexus projects and threads.
3. Map the harness conversation and the Claude transcript into t3code's turn items, with streaming.
4. Map sending, steering and interrupting onto the Nexus routes.
5. Map t3code's terminal RPC onto the attach route.
6. Map t3code's diff and checkpoint queries onto `/changes` and `/diff`.
7. Map previews onto Nexus previews.
8. Map attention onto t3code's notification coordinator.
9. Package, sign and update the Electron app for the Mac.
10. Build CI for a pnpm, Vite+ and Electron monorepo next to Nexus's `node --test`.
11. Follow upstream, or freeze the fork and own all of it.

That is 10 to 20 PRs before it matches the dashboard, plus permanent upkeep.

**Risks.** The fork falls behind upstream at once. Its RPC contract, its event-sourced orchestration and its checkpoints duplicate state that the Nexus registry and pi-durable already own, so the two could disagree. Most of the code would be about providers Nexus never runs.

**API.** Everything in the table above, plus a JSON conversation stream for Claude workers and an interrupt for them.

## Option 2: adapt t3code or Jetline so Nexus threads appear in them

### 2a. A Nexus provider in t3code

A t3code provider implements `ProviderAdapterV2` ([`ProviderAdapter.ts`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/packages/provider-core/src/server/ProviderAdapter.ts) lines 543 to 648). It has `getCapabilities`, `planSelectionTransition` and `openSession`. A session must provide these members:

| Member | What a Nexus provider would do |
|---|---|
| `events` | Follow `GET /v1/threads/<thread>/events` for a harness thread. For a Claude worker, follow `session.*` on `/v1/events` and read `/conversation` after each one, until a JSON stream exists. Then turn entries into t3code's turn items, such as messages, command executions and file changes |
| `ensureThread`, `resumeThread` | Start a thread with `POST /v1/threads`, or attach to an existing one |
| `startTurn`, `steerTurn` | `POST /v1/threads/<thread>/messages` with mode `followUp` or `steer` |
| `interruptTurn` | `POST /abort` for a harness thread. Claude workers have no route for this |
| `respondToRuntimeRequest` | Nothing. Pylons run without approval prompts, a decision on [the roadmap](../roadmap.md#not-planned) |
| `readThreadSnapshot` | `GET /v1/threads/<thread>/conversation` |
| `rollbackThread`, `forkThread` | Unsupported. Nexus cannot fork a thread yet |

The registry of providers is a compile-time list, `BUILT_IN_DRIVERS` ([`builtInDrivers.ts`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/apps/server/src/provider/builtInDrivers.ts) line 29). So a native provider means a fork. A **Local ACP command**, any executable that speaks the Agent Client Protocol on stdio, plugs in without a fork ([ACP providers](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/docs/user/providers-acp.md) line 32). A `nexus acp` command could be that bridge, in about 4 to 6 PRs in this repository.

**Why it is not enough.** A provider only covers the conversation. The t3code server still runs on the Mac, so its diffs, file reads, checkpoints and terminal drawer act on the Mac's directory for the project, not on the pylon. Of the five needs, it meets one.

### 2b. A t3code server inside each pylon

Run `t3` as a service in every pylon, publish it as a preview, and connect t3code's desktop app to each pylon as its own environment. Diffs, files and terminals are then correct, because that server does own the checkout.

**Why it does not fit.**

- It uses neither the attach route nor Herdr, because t3code runs its own PTYs.
- It does not show the Nexus agent's conversation, or the Claude worker's. t3code starts its own Claude sessions through the Agent SDK.
- Nexus's idle rules don't see t3code's activity, so a pylon could pause in the middle of a t3code turn.
- Each thread is a separate environment, with its own pairing token. A paused pylon is an environment that cannot be reached.
- The image needs Node 26.

### 2c. A Nexus bridge for Jetline

Jetline connects to a machine by running a command whose stdin and stdout carry its protocol. A `nexus jetline-bridge` command could speak that protocol and translate it to Nexus.

**What the bridge has to do.**

- Answer `hello` with exactly protocol version 1 ([`Wire.swift`](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/Sources/JetlineApp/Protocol/Wire.swift) line 18).
- Make up repositories and git worktrees from Nexus projects and threads. A Jetline workspace must have a branch and a worktree path ([`Workspace.swift`](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/Sources/JetlineApp/Models/Workspace.swift)).
- Map `terminal.attach` onto the attach route, counting byte offsets itself, because Herdr has none.
- Translate the Claude transcript into Jetline's chat items.
- Build diff snapshots from `/changes` and `/diff`.

The catalogue in [`API.swift`](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/Sources/JetlineApp/Protocol/API.swift) has about 54 methods. Their JSON shapes are Swift's derived `Codable` encodings, which are documented only by the Swift types. The bridge is about 6 to 10 PRs.

**Why it falls short.**

- Jetline has no comments on diff lines and no system notifications, so two of the five needs would still be missing.
- It runs only on macOS 26 or later ([`Package.swift`](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/Package.swift) line 18, [`Info.plist`](https://github.com/MartinRybergLaude/jetline/blob/918fa8656cab856eae29337399548d0b29527a1a/BundleResources/Info.plist) line 28).
- It is licensed EUPL-1.2, a copyleft licence, so adding those features in a fork keeps the fork under EUPL.
- Any change to Jetline's protocol breaks the bridge.

**API for option 2.** 2a and 2c need the same additions as option 1. 2b needs none but ignores Nexus's sessions.

## Option 3: keep the web dashboard and close its gaps

**Steps, each one PR, in this order:**

1. **A terminal on the thread page.** Serve xterm.js and its WebGL renderer as dashboard assets, and open the attach route from a drawer under the conversation. The drawer shows `waiting` while the pylon wakes, sends `resize` when its size changes, and shows `exit` and `error`. The sketch in [the verification](../verification/desktop-app/README.md) does this, except that it injects xterm.js instead of serving it. The API needs no change. The CSP's `connect-src 'self'` admits the socket. Its `style-src 'self'` blocks the `<style>` elements xterm.js adds, so xterm.js's default DOM renderer draws text in black on black. The WebGL renderer draws correctly under the same CSP. Use it, or add a per-page nonce to `style-src`. libghostty's WASM build, which t3code uses, would need `'wasm-unsafe-eval'` in `script-src`. Size: medium.
2. **Pushed updates.** Follow `GET /v1/events?follow=true` and refresh the regions an event touches, instead of polling every 5 seconds. The route exists, and its events cover sessions, turns, failures, parking and attention ([`events.ts`](../../src/events.ts)). It has no events for a pylon's state, for previews, or for a thread's start, archive and deletion. Add those kinds, or keep a slower poll for them. Size: medium, or two PRs with the new kinds.
3. **A build step for the dashboard client.** `@pierre/diffs` depends on Shiki, so it can't be vendored as one file the way xterm.js can. Bundle `dashboard/client.js` with esbuild, and keep serving the result from `'self'`. Size: small.
4. **Syntax-highlighted diffs,** the existing roadmap item, on `@pierre/diffs`. Its licence is Apache-2.0, so its NOTICE goes with it. Size: medium.
5. **Review comments on the diff,** the existing roadmap item, after t3code's flow. Select lines, write a note, and the notes go to the composer with their file and lines. The review is sent with `POST /messages`. Size: medium.
6. **Previews over HTTPS,** the existing roadmap item. Keep opening a preview in its own tab. A preview panel inside the page would need `frame-src` in the CSP, and the app in the pylon would have to allow framing. Size: small to medium.
7. **An installable dashboard.** Add a web app manifest and icons, so that Chrome or Edge **Install** and Safari **Add to Dock** open the dashboard in its own window with a dock icon. Installing needs HTTPS, which the 7443 listener provides. The existing system notifications then come from that window. Size: small.
8. **Keyboard and polish,** the existing **Dashboard polish** item: a command palette, moving between threads with the keyboard, focusing the terminal, and the live working clock. Size: medium.
9. **Only if needed: notifications with no window open.** Web Push needs a service worker, a VAPID key pair on the control plane, the subscriptions in the registry, and egress from the control plane to the browser's push service. If Web Push can't do it, build a small native shell that loads the dashboard and runs in the menu bar. Decide after step 7. Size: medium.

Steps 1 to 8 are 8 or 9 PRs, and step 9 adds one or two. Steps 1, 2, 7 and 8 do not depend on each other.

**Risks.**

- The dashboard client grows from about 1,000 lines of plain JavaScript into an application. That is real work, and it is the price of the feel the person wants.
- The attach opens Herdr's own interface, with its list of workspaces, which looks different from a terminal that opens straight into one session. Landing in one pane needs a change to the probe's attach script, or Herdr support.
- Web Push from a self-hosted control plane is untested here.

**Not affected.** The client mods keep using the CLI's JSON. The CLI contract does not change for any step above.

**For any client other than the dashboard.** Two additions would help any later client, the mods included, but option 3 does not need them. One is a JSON stream of a Claude worker's conversation on `GET /v1/threads/<thread>/events`. The other is an interrupt for a Claude worker, which presses Escape in its session. Both change the CLI's contract and would bump its version.

## Comparing the options

| | 1. Fork t3code | 2a. Provider in t3code | 2b. t3code in each pylon | 2c. Jetline bridge | 3. Dashboard |
|---|---|---|---|---|---|
| Terminal on the attach route | After a rewrite | No | No, its own PTYs | Yes, through the bridge | Yes, shown in a sketch |
| Claude worker's conversation | After a mapping | Yes, through the bridge | No | After a translation | Yes, today |
| Diffs with review comments | Yes, after a mapping | No, the diffs are of the Mac's directory | Yes, but of t3code's own agent | Diffs only | After steps 3 to 5 |
| Previews | After a mapping | No | Its own browser panel | Port forwarding only | Yes, today |
| Native notifications | Yes, Electron | Yes, Electron | Yes, Electron | Dock bounce only | Yes in an open window. Web Push or a shell for the rest |
| PR-sized steps | 10 to 20, large | 4 to 6 | Not estimated, because it fails two needs | 6 to 10 | 8 or 9, plus 1 or 2 |
| Upkeep | A permanent fork | Follow ACP and t3code | Follow t3code | Follow Jetline's protocol | Nexus's own code |

## Verification

[The verification folder](../verification/desktop-app/README.md) has the captures and the script for the claims above. In short:

- t3code ran from source in this pylon, on Node 24 rather than the Node 26 it asks for, because Node 26's binary needs `libatomic`, which the pylon image lacks. A real Claude Sonnet 5.5 turn edited a copy of this repository. The captures show the conversation, the folded tool calls, the diff with a line comment that became a composer chip, and the terminal drawer.
- `attach-terminal.mjs` ran against the local stack from nexus#86. In headless Chromium, the thread page opened the attach route under the dashboard's own CSP. xterm.js rendered Herdr's screen, a typed command's output came back, and a resize kept the terminal attached. A page on another origin got 403. Under the dashboard's CSP, xterm.js's DOM renderer lost its colours, and its WebGL renderer drew them.
- Jetline was not run, because it needs macOS 26. Its claims come from its source and README.
- Not checked: an installed dashboard window, Web Push, and how either app feels in daily use on the Mac.
