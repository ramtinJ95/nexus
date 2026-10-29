# Terminal tab fidelity verification

Verified in this thread's pylon on 2026-10-29, on branch `feat/terminal-fidelity` against main at `94cf908`. The stack ran Claude Code 2.1.310 on Sonnet 5.5, Herdr 0.9.5, Node 26.12.1 and headless Chromium 153 from `@sparticuz/chromium`, at 1440 by 900. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<folder of a fonts.conf listing its fonts> \
  RUNS=main HIDDEN=0 docs/verification/terminal-fidelity/run.sh origin/main HEAD
MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=... RUNS=branch docs/verification/terminal-fidelity/run.sh origin/main HEAD
```

`run.sh` checks out the commit into a worktree, copies `stack.ts` into it, builds the dashboard and runs `stack.ts drive` there. The captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same file and the same steps. `HIDDEN=0` skips the ten and a half minutes of a hidden page, which main has no code for, and its terminal has already ended by then. The run needs passwordless sudo and the Claude token placeholder in `/etc/profile.d/nexus-secrets.sh`, as a pylon has. `@sparticuz/chromium` unpacks its libraries only on AWS Lambda, so `al2023.tar.br` was unpacked by hand for `LD_LIBRARY_PATH`. Its fonts have no monospace face, so this run's `fonts.conf` also lists DejaVu Sans Mono from the npm package `dejavu-fonts-ttf` and makes it `monospace`.

## The stack

Docker is not available in this pylon, so `stack.ts` is [the thread-page-interaction stack](../thread-page-interaction/README.md): the real `startControlPlane` and probe server of the checkout under test, each in a child process, and a VM backend that boots nothing, whose one pylon is this machine as the Linux user `verify`. Herdr, the Claude Code launch and its hooks, the attach route and the relay under it are the checkout's own code, and the Claude worker is a real Claude Code. The stand-in is tailscaled's whois, which answers every caller but the probe as the person's laptop.

Two things are new here. The page reaches the API through a TCP proxy on port 7471, so the driver can reset the attach socket's connection as a dropped link does, without the page knowing. And the page reports a Mac's `navigator.platform`, which is what xterm.js reads to treat Option as a Mac's, so Option-drag takes the Mac path in Linux Chromium.

The driver starts a Claude worker in project `drinks`, opens its thread page on the Terminal tab, and then:

1. Drags across `Reply with the single` in Claude's pane, then drags across it again holding Option and presses ⌘C. It reads the clipboard after each, and logs every OSC 52 the pylon sends.
2. Types `This message has two lines.`, Shift+Enter, `Reply with only this link and nothing else: https://example.com/nx`, and Enter.
3. Hovers the link Claude printed and clicks it. The page's `window.open` records its arguments instead of opening a tab.
4. Asks Claude through the terminal to call AskUserQuestion, and looks for the question on the page while the terminal shows. It answers in the terminal with Enter.
5. Resets the TCP connection under the attach socket, records each change of the terminal's status line, and types `Reply with the word PLUM.` once it is attached.
6. On the branch, minimizes the browser window for ten and a half minutes, then restores it.

`timeline.txt` holds each step, `cli-*.txt` each CLI call, and `panes-*.txt` what each Herdr pane showed.

## Main (`main/`) and this branch (`branch/`)

| Step | main, 94cf908 | this branch |
|---|---|---|
| A drag in Claude's pane, `02-herdr-drag.png` | Herdr selected it and sent `ESC ] 52 ; c ; <base64 of "Reply with the single">` on release. xterm.js has no OSC 52 handler, so the clipboard still held `(nothing copied yet)` | The same OSC 52, and the clipboard held `Reply with the single` |
| Option-drag, then ⌘C, `03-option-drag.png` | xterm.js gave the drag to Herdr, which selected and sent a second OSC 52. No selection in the page, and ⌘C copied nothing | xterm.js selected natively, with 2 selection boxes, Herdr got no drag and sent nothing, and ⌘C copied `Reply with the single` |
| Shift+Enter, `04-shift-enter.png`, `cli-04-conversation-shift-enter.txt` | Sent a CR. Claude got `This message has two lines.` alone and answered that only one line came through. The second line went as a message of its own | Sent ESC CR, which Herdr passed to Claude as a newline. Claude's prompt held both lines, and Enter sent them as one message |
| The link Claude printed, `06-link-hover.png` | The pointer stayed the default arrow, and a click called no `window.open` | The pointer became a hand, and a click called `window.open("https://example.com/nx", "_blank", "noopener")` |
| A question while the terminal shows, `07-question.png` | The question's card was in the dock, which the terminal view hid. Nothing on the page showed it after 20 s | The card, `Claude asks Fruit Which fruit do you want?`, showed under the terminal 0.8 s after the thread asked, with the state bar's `Waiting for you`. The composer stayed hidden |
| The attach socket's connection reset, `08-dropped.png`, `09-after-drop.png` | `The connection dropped. Herdr keeps the session, so attach again.` and the Attach again button. No second socket in 45 s | `The connection dropped. Attaching again in 1 s.`, then attached again on a second socket. `Reply with the word PLUM.` reached Claude, which answered |
| The page hidden for ten and a half minutes, `11-shown-again.png` | Not run | The attach socket closed 599 s after the window was minimized, and the status line said `Detached while the page was hidden, so the pylon can pause. It attaches again when the page shows.` Restoring the window opened a third socket, attached 0.6 s later |

The branch with a question that arrived while the terminal shows:

![branch, a question under the terminal](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/terminal-fidelity/docs/verification/terminal-fidelity/branch/07-question.png)

Main at the same moment:

![main, the question hidden](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/terminal-fidelity/docs/verification/terminal-fidelity/main/07-question.png)

The branch after Shift+Enter, with two lines in Claude's prompt:

![branch, Shift+Enter](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/terminal-fidelity/docs/verification/terminal-fidelity/branch/04-shift-enter.png)

Main after Shift+Enter, where the first line went alone:

![main, Shift+Enter](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/terminal-fidelity/docs/verification/terminal-fidelity/main/04-shift-enter.png)

## Not checked live

- Safari and Firefox. Only Chromium runs in this pylon, and the hosts their builds download from are blocked. Safari may refuse a clipboard write that does not follow a user gesture closely, and Herdr's OSC 52 arrives a round trip after the mouse release.
- A real Mac. Option-drag ran in Linux Chromium with the page told it was on a Mac, and ⌘C was Chromium's copy command. Option typing @ [ ] { } | \ on a Swedish layout was not typed. The unit test checks that Option with any key but Enter stays xterm.js's.
- The dashboard over HTTPS on the tailnet name. The page here was plain HTTP on 127.0.0.1, which browsers treat as a secure context, so `navigator.clipboard` exists. On a plain-HTTP tailnet address it does not, and copying out does nothing there.
- A real network drop. The driver reset the TCP connection at a proxy. A link that stalls without a reset ends when the server's 15-second ping goes unanswered, which was not waited out here.
- A control plane that restarts. That closes the socket after an `unreachable` error, and a retry's upgrade is refused while it is down. The unit tests cover both. The live run covered only the reset.
- A Nexus agent thread's terminal. Its composer is hidden under the terminal too, as for a Claude worker.
