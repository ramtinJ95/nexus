# Claude activity and attention accuracy verification

Verified in this task's pylon on 2026-10-26 with Claude Code 2.1.308 and Herdr
0.9.5, starting from main `0663299`. Every Claude ran in an isolated Herdr
server, under a HOME of its own, with its hooks pointed at a logger or at a local
capture server. Nothing reached the live control plane through these runs, and
no image was built. Each pane loaded the per-boot `CLAUDE_CODE_OAUTH_TOKEN`
placeholder from `/etc/profile.d/nexus-secrets.sh` and unset `GH_TOKEN`. No token
is in these captures.

## What the hooks show

`log-hook.cjs` logged every hook's input, a few environment variables, and the
process chain up to the Claude running the hook, with the environment each Claude
process started with. `summary.cjs` prints a log one line per hook.
`exploration/` holds the first three runs, under the pylon user.

A background command (`exploration/background-command-hooks.jsonl`). The prompt
asked Claude to start a 150-second command with Bash `run_in_background` and end
its turn at once.

- The Stop fires 3.6 seconds in, with the command in `background_tasks` as
  `{"type": "shell", "status": "running", ...}`.
- 60 seconds after that Stop, while the command still runs, Notification fires
  with `notification_type: "idle_prompt"`.
- When the command finishes, at 152.7 seconds, Claude submits a
  `<task-notification>` prompt, so UserPromptSubmit fires and a new turn starts.
  Its Stop has `background_tasks: []`.
- Another `idle_prompt` fires 60 seconds after that Stop.

So the old hook ends the turn while Claude waits on the command, and its
Notification matcher, which included `idle_prompt`, reports the idle prompt as
`session.waiting`. A thread whose person had read the reply then shows
`waiting` until the command's finish starts the next turn. That is problem 2,
seen on th-d23e53da8b9c.

An AskUserQuestion dialog (`exploration/ask-user-question-hooks.jsonl`) fires
Notification with `notification_type: "permission_prompt"` 6 seconds after its
PreToolUse.

Nested sessions (`exploration/nested-env-hooks.jsonl`). This task's own Claude
ran `claude -p` from its Bash tool, once as is and once with
`env -u CLAUDECODE`. Claude Code does not refuse either. The process chain shows
that a Claude Nexus starts in a Herdr pane begins with no `CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID` or `CLAUDE_PID` in its environment. A nested Claude
begins with its parent's `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID`, and keeps
them after `env -u CLAUDECODE`. Every hook gets `CLAUDE_PID`, the Claude that
runs it.

## End to end through the branch's hook

A pylon user's Claude reports only under its own HOME. So these runs used a
`verify` Linux user, created for them, whose HOME is `/home/verify`.
`verify-settings.ts` wrote its `settings.json` with the logger on every hook and
the hook table from this branch's `install.ts`, pointing at copies of this
branch's `nexus-claude-hook` and `nexus-heartbeat.ts`. The Herdr server and its
panes had `NEXUS_API=http://127.0.0.1:47811`, so `nexus event` posted to
`../claude-background-subagents/capture-server.mjs`. `hooks.jsonl` is the
logger's record and `events.jsonl` is what the capture server received. Three
sessions ran at once, and the `pane-*.txt` files are their screens.

- `927f6327`, a background command. It started the same 150-second command and
  ended its turn with "waiting on the suite".
- `ff3ae72a`, a background dev server. It started `python3 -m http.server 8765`
  in the background and ended its turn with "server is up".
- `6019981b`, nested sessions and a question. It ran `claude -p` from its Bash
  tool, then a `claude -p` under `~/iso-home` with `CLAUDECODE`,
  `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` unset, then asked an AskUserQuestion
  question. The first two attempts were not logged in, because Claude Code drops
  `CLAUDE_CODE_OAUTH_TOKEN` from its tools' environment. A second prompt reran
  both with the token sourced, and both answered.

`timeline.txt` is `node replay.ts hooks.jsonl events.jsonl <main checkout>
<sessions>` for each run. It replays the run into a fresh registry three ways:
the old hook's reports on main's registry, the same reports on this branch's
registry, and the branch hook's captured reports on this branch's registry.
The person reads each reply as soon as it shows.

With the old hook on main's registry, all three problems show.

- The command's Stop gives a reply 3.9 seconds in, while the command has
  2.5 minutes left.
- Its idle prompt makes the thread `waiting` at 63.9 seconds, until the
  command's finish starts a turn at 152.8 seconds. The dev server's idle prompt
  leaves its thread `waiting` for good.
- Each nested session's turn end gives the thread a reply while the primary
  session's turn runs, at 74.5 and 77.4 seconds.

With the branch's hook:

- The command's Stop sends nothing, because the tool heartbeat a second earlier
  holds the five-minute throttle. The session stays `working` until the Stop of
  the turn the command's finish started, at 154.0 seconds. The turn end held
  back for the command arrives 600 seconds after its Stop, stamped with the
  Stop's time, and the registry ignores it as stale.
- The dev server's session stays `working` until its held turn end arrives at
  603.6 seconds, which gives the reply.
- No idle prompt is reported. The AskUserQuestion prompt reports
  `session.waiting`, and the tool heartbeat after the answer resumes the turn.
- The nested sessions `182e4cc0` and `01698671` ran full turns, Stop included,
  and the capture server received nothing from them. The `ps` listing during
  the run showed both held turn ends as `sh -c sleep 600 && exec nexus event ...`
  processes in their own process groups, outliving the hook that started them.

The old hook on this branch's registry is the control plane deployed before
the image. A waiting report for a session with no running turn is ignored, so
the idle prompt after a turn end no longer makes a thread `waiting`. The other
problems remain until the image is rebuilt.

## Checks

`typecheck.txt` and `tests.txt` are `npm run typecheck` and `npm test` on the
branch.

## Not verified

- A rebuilt pylon image, and a worker started through the control plane. The
  hook ran from this branch's files, copied into the `verify` user's HOME.
- A Notification with `elicitation_dialog`, which needs an MCP server that asks
  for input.
- An idle prompt while a background subagent runs beside a background shell.
  The old hook keeps that session working, so if the idle prompt fires, the
  control plane cannot tell it from a permission prompt, and the thread shows
  `waiting` until the image narrows the matcher.
