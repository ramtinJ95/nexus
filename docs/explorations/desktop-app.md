# A desktop app as Nexus's main interface

This page explores [the roadmap's item](../roadmap.md#the-dashboard-wave) on whether a desktop app becomes Nexus's main interface. Neither the client mods nor the web dashboard feels good enough as the place to work with threads. The page looks at what makes [t3code](https://github.com/pingdotgg/t3code) and [Jetline](https://github.com/MartinRybergLaude/jetline) work well, then weighs three ways forward. The person decides. Until then the roadmap item stays open.

Written on 2026-10-26 against Nexus at `a9a356c`, and updated for [nexus#87](https://github.com/ramtinJ95/nexus/pull/87) at `66f3de2`. It uses t3code at [`c58beff`](https://github.com/pingdotgg/t3code/tree/c58beff8102e179493d8aae66d5e44c3c8cd0f46) and Jetline at [`918fa86`](https://github.com/MartinRybergLaude/jetline/tree/918fa8656cab856eae29337399548d0b29527a1a).

## Recommendation: keep the web dashboard and close its gaps

Keep the dashboard as the place to work with threads, and build what it lacks: a terminal on the thread page, pushed updates instead of polling, highlighted diffs with review comments, and an installable window. Copy ideas, and MIT code where it fits, from t3code's web app. That also covers the best case for a new Nexus client, which option 1b weighs. Don't fork t3code, and don't adapt t3code or Jetline to show Nexus threads. Leave a native desktop shell for later. Build one only if notifications must arrive when no dashboard window is open and Web Push can't deliver them.

The reasons, in short:

- **Neither app can reach a pylon.** t3code's server and Jetline's engine both own the checkout, the terminals and the agent process on the machine they run on. A Nexus thread's checkout and sessions are in a pylon that only the control plane reaches. Either app would need a layer that translates its whole client protocol into Nexus's API. That layer is most of the work of a new client, and it then has to keep pace with someone else's code.
- **The dashboard already speaks the API and has the hard parts.** It has attention and the seen marker, system notifications, the Claude worker's live conversation from [nexus#86](https://github.com/ramtinJ95/nexus/pull/86), Changes and Latest turn, and previews. It sits behind the same tailnet check as every route.
- **The terminal works from the dashboard today.** A browser terminal on the thread page attached to a pylon's Herdr session through the attach route. The socket opened under the dashboard's own Content Security Policy. Typing, output and resize all worked. xterm.js needs its WebGL renderer, or a CSP nonce, to draw under that policy. [The verification](https://github.com/ramtinJ95/nexus/blob/2c88196d10cd9108d655a05153efa7f72dfdf394/docs/verification/desktop-app/README.md) has the script and the captures.
- **Most gaps are client work.** The dashboard's own roadmap items cover diffs, review comments and polish. Previews over HTTPS landed in [nexus#87](https://github.com/ramtinJ95/nexus/pull/87). The dashboard needs two additions below the client. One is events for pylon state, previews and a thread's lifecycle, so that it can stop polling. The other is a latest-turn snapshot for each Claude worker turn, which only harness turns have today. A JSON stream of a Claude worker's conversation and an interrupt for one are needed only by clients other than the dashboard.

The case against this recommendation is feel. t3code and Jetline feel fast because the client keeps a local copy of state that the server pushes to it, and because the terminal, the conversation and the diff share one window with a keyboard model. The dashboard renders HTML on the server and polls every 5 seconds. Closing that gap means more client code in the dashboard, and probably a build step for it. It does not need a new app.

## What the interface must have

The roadmap names five things. This table says what Nexus already provides for each, and what any client still lacks.

| Need | Nexus provides today | Missing |
|---|---|---|
| A real terminal on a pylon's sessions | `GET /v1/threads/<thread>/attach`, a WebSocket that [`src/attach-wire.ts`](../../src/attach-wire.ts) defines and [`src/control/attach.ts`](../../src/control/attach.ts) serves. The CLI uses it. The route admits a page from the dashboard's own origin, or a client that sends no `Origin`, such as the CLI or a desktop app's main process ([`api.ts`](../../src/control/api.ts) line 1041) | A terminal in any graphical client. The attach opens Herdr's own interface, with its list of workspaces, not one session's pane. Output has no byte offsets, so a client that reconnects gets a fresh screen from Herdr rather than the bytes it missed |
| The Claude worker's conversation | `GET /v1/threads/<thread>/conversation` returns the worker's transcript as JSON. `POST /v1/threads/<thread>/messages` types a message into its session. `GET /v1/events?follow=true` streams `session.*` events. The dashboard streams the conversation as HTML on `/threads/<thread>/stream` | A JSON stream of the transcript. `GET /v1/threads/<thread>/events` refuses a Claude worker thread with 409, because it has no harness conversation (`conversing` in [`api.ts`](../../src/control/api.ts)). An interrupt for a Claude worker. `POST /v1/threads/<thread>/abort` reaches only the harness |
| Diffs with review comments | `GET /v1/threads/<thread>/changes` and `/diff`, from the boot commit or from HEAD. From the latest turn too, for a harness thread and for a Claude worker thread whose pylon's image takes Claude turn snapshots | Syntax highlighting and review comments, done in [nexus#94](https://github.com/ramtinJ95/nexus/pull/94) and [nexus#97](https://github.com/ramtinJ95/nexus/pull/97). A review goes to the agent as an ordinary message, so it needs no new route. GitHub review comments need the pull request watch to post them |
| Previews | The thread detail lists each preview with its tailnet HTTPS URL. `POST` and `DELETE /v1/threads/<thread>/previews` publish and unpublish a port. Since [nexus#87](https://github.com/ramtinJ95/nexus/pull/87) the preview gateway keeps the browser on HTTPS. It rewrites redirects to a preview's own `http://` address and sends `upgrade-insecure-requests` ([design](../design.md#the-parts)) | Showing a preview inside the dashboard, which its CSP forbids today (`default-src 'none'` with no `frame-src`, [`dashboard.ts`](../../src/control/dashboard.ts) line 107) |
| Native notifications | Attention on every thread row. The dashboard shows a system notification for a failed, parked or replied thread when its window is not focused and it is served over HTTPS ([design](../design.md#shared-attention-and-dashboard-notifications)) | A notification when no dashboard window is open. That takes Web Push or a native app that runs in the background |

## What makes t3code and Jetline work well

Both apps put the conversation, a terminal and the diff in one window, next to each other, and both keep the client's state current without polling. The details differ.

**t3code.** Its web app and server ran from source in a pylon, with a copy of this repository as a project and a real Claude turn on it. The captures are in [the verification folder](https://github.com/ramtinJ95/nexus/blob/2c88196d10cd9108d655a05153efa7f72dfdf394/docs/verification/desktop-app/README.md).

- A turn's tool calls fold into one line, "Ran 2 commands, changed 1 file, and performed 3 other actions", which opens into one row per call ([capture](https://github.com/ramtinJ95/nexus/blob/2c88196d10cd9108d655a05153efa7f72dfdf394/docs/verification/desktop-app/t3code-tool-calls.png)). The reply ends with a card of the files it changed and an **Open diff** button ([capture](https://github.com/ramtinJ95/nexus/blob/2c88196d10cd9108d655a05153efa7f72dfdf394/docs/verification/desktop-app/t3code-conversation.png)).
- The diff opens beside the conversation and is scoped to the latest turn by default. It is rendered by [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs) 1.6.1, which is Apache-2.0 licensed and depends on Shiki. Click a line number, press **+**, type a note and press Ctrl+Enter. The note stays beside the line, and a chip such as "README.md L26" lands in the composer, so the next message carries it ([capture](https://github.com/ramtinJ95/nexus/blob/2c88196d10cd9108d655a05153efa7f72dfdf394/docs/verification/desktop-app/t3code-diff-comment.png), [`AnnotatableCodeView.tsx`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/apps/web/src/components/diffs/AnnotatableCodeView.tsx)).
- The terminal is a drawer under the conversation, in the project's directory ([capture](https://github.com/ramtinJ95/nexus/blob/2c88196d10cd9108d655a05153efa7f72dfdf394/docs/verification/desktop-app/t3code-terminal.png)). The server owns the PTYs and keeps 5,000 lines of history, so a client that reconnects gets the output back. The web app renders it with libghostty compiled to WASM ([terminal runtime](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/docs/internals/terminal-runtime.md)).
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

## Option 1b: a small Nexus client that borrows t3code's components

This is the strongest form of option 1. Build a new client on Nexus's own API, such as a React app that the control plane serves, which a native shell could wrap later. Copy only the parts of t3code that stand alone, and leave its server, its contract and its state model behind.

**What can be borrowed.** These counts come from reading the imports at the pinned revision.

- The terminal renderer in [`terminal/ghostty/`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/apps/web/src/terminal/ghostty) is about 1,850 lines, libghostty compiled to WASM, and its files import only each other. It copies as it is, with its MIT notice, and it needs `'wasm-unsafe-eval'` in `script-src`.
- The diff view is the `@pierre/diffs` package itself. t3code's comment layer on top of it, [`AnnotatableCodeView.tsx`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/apps/web/src/components/diffs/AnnotatableCodeView.tsx) and `DiffCommentAnnotation.tsx`, is about 450 lines, but it writes to t3code's composer store and uses its contracts. It is a pattern to follow more than code to copy.
- The larger components are tied to t3code's stores, its Effect state and its client runtime. [`DiffPanel.tsx`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/apps/web/src/components/DiffPanel.tsx) has 1,179 lines, [`ThreadTerminalDrawer.tsx`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/apps/web/src/components/ThreadTerminalDrawer.tsx) 1,960 and [`MessagesTimeline.tsx`](https://github.com/pingdotgg/t3code/blob/c58beff8102e179493d8aae66d5e44c3c8cd0f46/apps/web/src/components/chat/MessagesTimeline.tsx) 1,457. Each imports between 25 and 45 of t3code's own modules, so they would be rewritten rather than copied. The tool-call grouping is the exception. Its logic is 20 lines.

**Benefits.**

- The client holds its own state and applies pushed updates from the start, which is where t3code's feel comes from.
- It has a component library and a build from day one.
- It carries none of the 203-method contract, and none of the upkeep of a fork.
- A native shell could wrap the same client later.

**Costs.** Before it gives the person anything new, it has to match the dashboard. That means the sidebar, the start and project dialogs, the harness and Claude conversations with streaming, the inspector, archiving, deleting and waking, and attention with the seen marker. The seen marker's rules in [the design](../design.md#shared-attention-and-dashboard-notifications) are subtle. For one example, the watermark comes from the rendered conversation and never from polling. Until the cut-over there are two clients to keep correct. Its conversation also needs a JSON stream of the Claude worker's transcript, or a reuse of the dashboard's HTML stream.

**Steps, each about one PR:**

1. Scaffold the client, its build, and its serving by the control plane.
2. Add the sidebar and the thread list, on the event stream.
3. Add the conversation for harness and Claude threads, with streaming. This needs the JSON stream for Claude workers.
4. Add the inspector, with Changes, Previews and Pylon.
5. Add the start and project dialogs, and archive, delete and wake.
6. Add attention, the seen marker and notifications.
7. Cut over and delete the old dashboard.
8. Then add the same features as option 3: steps 1, 2, 4 to 6 and 8 to 10.

That is about 7 PRs to match the dashboard, then about the same 8 or 9 as option 3.

**Does the dashboard still win?** Yes, as the order of work. Option 3 delivers the same features without the 7 PRs of matching what exists, and each of its PRs reaches the person when it lands. The two options also meet. Borrowing t3code's parts into the dashboard is option 3: the terminal renderer, `@pierre/diffs`, the comment flow and the tool-call grouping. If the dashboard's client outgrows server-rendered HTML and plain JavaScript, it can move to a client-rendered app one page at a time. That is option 1b, reached without a phase that only rebuilds what exists. The real question between them is whether to pay that cost up front for a cleaner client from the start. This page says no, because the person feels the gaps now, not the client's structure.

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

1. **A terminal on the thread page.** Serve xterm.js and its WebGL renderer as dashboard assets, and open the attach route from a drawer under the conversation. The drawer shows `waiting` while the pylon wakes, sends `resize` when its size changes, and shows `exit` and `error`. The sketch in [the verification](https://github.com/ramtinJ95/nexus/blob/2c88196d10cd9108d655a05153efa7f72dfdf394/docs/verification/desktop-app/README.md) does this on the real thread page, with xterm.js added to the page's HTML and loaded from the dashboard's own origin. The API needs no change. The CSP's `connect-src 'self'` admits the socket. Its `style-src 'self'` blocks the `<style>` elements xterm.js adds, so xterm.js's default DOM renderer draws text in black on black. The WebGL renderer draws correctly under the same CSP. Use it, or add a per-page nonce to `style-src`. libghostty's WASM build, which t3code uses, would need `'wasm-unsafe-eval'` in `script-src`. Size: medium.
2. **Pushed updates.** Follow `GET /v1/events?follow=true` and refresh the regions an event touches, instead of polling every 5 seconds. The route exists, and its events cover sessions, turns, failures, parking and attention ([`events.ts`](../../src/events.ts)). It has no events for a pylon's state, for previews, or for a thread's start, archive and deletion. Add those kinds, or keep a slower poll for them. Size: medium, or two PRs with the new kinds.
3. **A build step for the dashboard client. Done in [nexus#94](https://github.com/ramtinJ95/nexus/pull/94).** `npm run build` bundles `dashboard/client.js` with esbuild, and a release builds it. The control plane serves the bundle from `'self'`, and each Shiki grammar is a chunk fetched when a file needs it.
4. **Syntax-highlighted diffs. Done in [nexus#94](https://github.com/ramtinJ95/nexus/pull/94).** The diff is highlighted by `@pierre/diffs`, unified or split. Its component writes inline styles as markup, which `style-src 'self'` blocks, so the dashboard draws the library's render as DOM in a shadow root and the CSP stays as it was. Review comments, step 6, need their own line selection.
5. **Latest-turn snapshots for Claude worker turns. Done in [nexus#91](https://github.com/ramtinJ95/nexus/pull/91).** The worker's `UserPromptSubmit` hook snapshots the checkout before Claude acts on each prompt, and a Claude thread's reads expect the snapshot of its newest recorded turn start ([design](../design.md#files-and-changes)). Pylons take snapshots once the image built from that change is current.
6. **Review comments on the diff. Done in [nexus#97](https://github.com/ramtinJ95/nexus/pull/97).** Select rows by their line numbers or with the keyboard, write a comment, question, suggestion or requested change, and the notes go to the composer with their file and lines. The review is sent with `POST /messages`. Answers beside the lines and posting to GitHub are [a roadmap item](../roadmap.md#the-dashboard-wave).
7. **Previews over HTTPS. Done in [nexus#87](https://github.com/ramtinJ95/nexus/pull/87).** The dashboard keeps opening a preview in its own tab. A preview panel inside the page would need `frame-src` in the CSP, and the app in the pylon would have to allow framing. That is not planned.
8. **An installable dashboard.** Add a web app manifest and icons, so that Chrome or Edge **Install** and Safari **Add to Dock** open the dashboard in its own window with a dock icon. Installing needs HTTPS, which the 7443 listener provides. The existing system notifications then come from that window. Size: small.
9. **Keyboard and polish,** the existing **Dashboard polish** item: a command palette, moving between threads with the keyboard, focusing the terminal, and the live working clock. Size: medium.
10. **Only if needed: notifications with no window open.** Web Push needs a service worker, a VAPID key pair on the control plane, the subscriptions in the registry, and egress from the control plane to the browser's push service. If Web Push can't do it, build a small native shell that loads the dashboard and runs in the menu bar. Decide after step 8. Size: medium.

Steps 1 to 9, without steps 5 and 7, are 7 or 8 PRs, and step 10 adds one or two. Steps 1, 2, 5, 8 and 9 do not depend on each other. Review comments on a Claude thread's latest turn need step 5.

**Risks.**

- The dashboard client grows from about 1,000 lines of plain JavaScript into an application. That is real work, and it is the price of the feel the person wants.
- The attach opens Herdr's own interface, with its list of workspaces, which looks different from a terminal that opens straight into one session. Landing in one pane needs a change to the probe's attach script, or Herdr support.
- Web Push from a self-hosted control plane is untested here.

**Not affected.** The client mods keep using the CLI's JSON. The CLI contract does not change for any step above.

**For any client other than the dashboard.** Two additions would help any later client, the mods included, but option 3 does not need them. One is a JSON stream of a Claude worker's conversation on `GET /v1/threads/<thread>/events`. The other is an interrupt for a Claude worker, which presses Escape in its session. Both change the CLI's contract and would bump its version.

## Comparing the options

| | 1. Fork t3code | 1b. Small Nexus client | 2a. Provider in t3code | 2b. t3code in each pylon | 2c. Jetline bridge | 3. Dashboard |
|---|---|---|---|---|---|---|
| Terminal on the attach route | After a rewrite | After its terminal step | No | No, its own PTYs | Yes, through the bridge | Yes, shown in a sketch |
| Claude worker's conversation | After a mapping | After a rewrite, with a JSON stream | Yes, through the bridge | No | After a translation | Yes, today |
| Diffs with review comments | Yes, after a mapping | After the same steps as option 3 | No, the diffs are of the Mac's directory | Yes, but of t3code's own agent | Diffs only | After steps 3 to 6 |
| Previews | After a mapping | After matching the dashboard | No | Its own browser panel | Port forwarding only | Yes, today |
| Native notifications | Yes, Electron | As the dashboard, or a shell | Yes, Electron | Yes, Electron | Dock bounce only | Yes in an open window. Web Push or a shell for the rest |
| PR-sized steps | 10 to 20, large | About 7, then option 3's 8 or 9 | 4 to 6 | Not estimated, because it fails two needs | 6 to 10 | 8 or 9, plus 1 or 2 |
| Upkeep | A permanent fork | Nexus's own code, with copied parts | Follow ACP and t3code | Follow t3code | Follow Jetline's protocol | Nexus's own code |

## Verification

[The verification folder](https://github.com/ramtinJ95/nexus/blob/2c88196d10cd9108d655a05153efa7f72dfdf394/docs/verification/desktop-app/README.md) has the captures and the script for the claims above. In short:

- t3code ran from source in this pylon, on Node 24 rather than the Node 26 it asks for, because Node 26's binary needs `libatomic`, which the pylon image lacks. A real Claude Sonnet 5.5 turn edited a copy of this repository. The captures show the conversation, the folded tool calls, the diff with a line comment that became a composer chip, and the terminal drawer.
- `attach-terminal.mjs` ran against the local stack from nexus#86. In headless Chromium, the thread page opened the attach route under the dashboard's own CSP. xterm.js rendered Herdr's screen, a typed command's output came back, and a resize kept the terminal attached. A page on another origin got 403. Both renderer checks ran on the real thread page under its real CSP, with xterm.js loaded from the dashboard's origin. The WebGL renderer drew correctly. The DOM renderer lost its colours and layout.
- Jetline was not run, because it needs macOS 26. Its claims come from its source and README.
- Not checked: an installed dashboard window, Web Push, and how either app feels in daily use on the Mac.
