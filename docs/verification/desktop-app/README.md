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
- xterm.js on the thread page rendered Herdr, a command typed into it printed its output, and a resize kept it attached (`attach-terminal.png`). This page injects xterm.js, which the dashboard's `script-src 'self'` would refuse, so it bypasses the CSP for that tag only. A terminal that ships with the dashboard is served from `'self'`.
- xterm.js served from `'self'` under the same CSP. With its DOM renderer the policy blocks the four `<style>` elements it adds, and the text is black on black (`xterm-csp-dom.png`). With its WebGL renderer the same four are blocked, but the text draws in its colours (`xterm-csp-webgl.png`).

Every thread on this stack shares one Herdr server, so the Herdr sidebar in `attach-terminal.png` lists a shell for each thread the script started. In a pylon each thread has its own.

## Not verified

- Jetline, which needs macOS 26. Its claims come from its source and README.
- An installed dashboard window, and Web Push.
- How either app feels in daily use on the Mac.
