# Desktop app exploration: verification

Captured in this task's pylon on 2026-10-26 for [the desktop app exploration](../../explorations/desktop-app.md). No live control plane, node, image or other thread was touched.

## t3code, run from source

t3code at [`c58beff`](https://github.com/pingdotgg/t3code/tree/c58beff8102e179493d8aae66d5e44c3c8cd0f46) was cloned outside the repo and run with its own dev runner, `node scripts/dev-runner.ts dev`, which starts its server on 13773 and its web app on 5733. It asks for Node 26.12.1, but Node 26's binary needs `libatomic.so.1`, which the pylon image lacks, so it ran on the image's Node 24.22.1. pnpm 12.14.0 installed its packages with `--ignore-scripts`. Its `t3` package on npm downloads a binary from GitHub releases, which the pylon's egress allowlist blocks.

The dev runner started from a login shell, so Claude Code found `CLAUDE_CODE_OAUTH_TOKEN`. A copy of this repository at `/home/user/t3demo/nexus` was added as a project through t3code's **Add project** dialog, and Claude Sonnet 5.5 was asked to read `src/attach-wire.ts` and add a short section to the copy's README.

- `t3code-conversation.png`. The finished turn, "Worked for 12s", with the changed-files card and **Open diff**.
- `t3code-tool-calls.png`. The turn's calls folded into "Ran 2 commands, changed 1 file, and performed 3 other actions", opened, with the diff beside the conversation.
- `t3code-diff-comment.png`. A note on line 26 of the diff, made by clicking the line number, pressing **+** and pressing Ctrl+Enter. The note shows under the line, and the composer holds a "README.md L26" chip.
- `t3code-terminal.png`. The terminal drawer, open in the project's directory, after `git status --short && ls`.

A first attempt typed the project path into the folder dialog, which put `~/` in front of it and created an empty folder. Claude then edited `README.md` in this task's own checkout instead. That edit was reverted at once, and it is not in this branch.

## A browser terminal on the attach route

`attach-terminal.mjs` drives the stack in [`../claude-thread-streaming/stack.ts`](../claude-thread-streaming/stack.ts), which runs the real registry, API and dashboard on `127.0.0.1:7470` with this machine as the pylon. Start the stack without the pylon's own Herdr variables, because Herdr refuses to start inside another Herdr:

```sh
env -u HERDR_ENV -u HERDR_SESSION -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_SOCKET_PATH \
	node docs/verification/claude-thread-streaming/stack.ts
MODULES=... node docs/verification/desktop-app/attach-terminal.mjs
```

`attach.log` is its output. Each line is a check it made:

- The thread page opened `GET /v1/threads/<thread>/attach` under the dashboard's own CSP and received Herdr's screen.
- A page on another origin was refused with 403.
- xterm.js on the thread page, with its WebGL renderer, rendered Herdr. A command typed into it printed its output, and a resize kept it attached (`attach-terminal.png`).
- The same page with xterm.js's default DOM renderer attached too, but its text is unreadable and its layout broken (`attach-terminal-dom.png`).

Both terminal checks run on the real thread page under its real headers and CSP. The dashboard does not serve xterm.js, so the script intercepts the page's own request, adds `<script>` and `<link>` tags for `/__terminal/...` to the HTML the stack returned, and answers those paths itself. The browser loads them from the dashboard's own origin, as it would load assets the dashboard ships. Nothing bypasses the CSP. The CSP is enforced: it refuses the `<style>` elements that xterm.js adds, which the log records as `style-src-elem`, and with the DOM renderer also its inline `style` attributes, as `style-src-attr`. With the WebGL renderer it refuses no script and no connection, and the colours still draw. Not tested: xterm.js served by the dashboard's own asset route, which does not exist yet.

Every thread on this stack shares one Herdr server, so the Herdr sidebar in `attach-terminal.png` lists a shell for each thread the script started. In a pylon each thread has its own.

## Not verified

- Jetline, which needs macOS 26. Its claims come from its source and README.
- An installed dashboard window, and Web Push.
- How either app feels in daily use on the Mac.
