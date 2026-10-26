# Claude activity and attention accuracy verification

Verified in this task's pylon on 2026-10-26 with Claude Code 2.1.308 and Herdr
0.9.5, starting from main `0663299` and rebased onto `1f6346c`. Every Claude ran in an isolated Herdr
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

A pylon user's Claude reports only under its own HOME, so these runs used a
`verify` Linux user, created for them, whose HOME is `/home/verify`.
`verify-settings.ts` wrote its `settings.json` with the logger on every hook and
the hook table from this branch's `install.ts`, pointing at copies of this
branch's `nexus-claude-hook` and `nexus-heartbeat.ts`. The Herdr server and its
panes had `NEXUS_API=http://127.0.0.1:47811`, so `nexus event` posted to
`../claude-background-subagents/capture-server.mjs`. `hooks.jsonl` is the
logger's record, `events.jsonl` is what the capture server received, and the
`pane-*.txt` files are the screens.

`timeline.txt` is `node replay.ts hooks.jsonl events.jsonl <sessions>` for each
session. It replays the session into a fresh registry twice: as the old hook
reports the raw hook inputs, and as the branch's hook did. The person reads each
reply as soon as it shows.

### Background commands

- `8ec342b7` started a 7-minute command in the background and ended its turn
  with "waiting on the suite".
- `c4acd325` started `python3 -m http.server 8765` in the background and ended
  its turn with "server is up". After 11 minutes I quit it with "Exit and stop
  tasks".

With the old hook, each Stop gives a reply 3 seconds in. Each idle prompt makes
the thread `waiting` at 63 seconds. For the command, that lasts until its finish
starts a turn at 422 seconds. For the server, it lasts until the session ends.

With the branch's hook, each Stop starts a detached `nexus-claude-hook hold`,
and neither session gets a reply while its background task runs.

- The command's hold sent a heartbeat at 303.7 seconds, stamped with the Stop's
  time. The command's finish started a turn at 422.2 seconds, and that turn's
  Stop gave the reply at 423.8 seconds. The hold saw the command gone and sent
  its turn end 30 seconds later, and the registry ignored it as stale.
- The server's hold sent heartbeats at 303.6 and 603.8 seconds. Its held turn
  end came after the session ended and was stale too.

This run's hold watched only the output file, which the next run replaced with
process groups.
- Neither idle prompt was reported.

### Process groups and one hold per session

`process-groups/` is a run of the final hook, with the same setup.

- `4d278340` started `exec python3 -c "import time; time.sleep(200)" >/dev/null 2>&1`
  in the background, so no process held the output file. The hook recorded one
  process group, 31320, the `exec`'d `python3`, a direct child of Claude leading
  its own group. The session stayed `working`, with no reply, until the turn the
  command's finish started at 202.7 seconds. The hold's turn end at 274.1 seconds
  was stale. That turn's own Stop never ran: this task's own session hit the
  account's usage limit at about that time, and the `verify` Claude used the same
  token, so the turn most likely failed (inferred, not captured).
- `9d31de68` started `python3 -m http.server 8765` and then got two more prompts,
  so three Stops listed the server. Each started a hold. Within a minute the two
  older holds saw the pidfile name the newest one and stopped, leaving one. It
  sent a heartbeat every 5 minutes, up to 1802 seconds, when this pylon paused
  and stopped every process in it.

`process-groups/timeline.txt` replays both. The 2-hour cap was not reached live.
The tests cover it, and the dashboard test shows its message as the thread's
state.

### Nested sessions and a question

`first-run/` holds an earlier run of the branch, whose held turn end was a fixed
10-minute timer, since replaced. Its background sessions are superseded by the
runs above. Its `6019981b` session still shows the rest.

- It ran `claude -p` from its Bash tool, then a `claude -p` under `~/iso-home`
  with `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` unset. Both nested
  sessions, `182e4cc0` and `01698671`, ran full turns, Stop included. Claude
  Code drops `CLAUDE_CODE_OAUTH_TOKEN` from its tools' environment, so the
  commands sourced the token first.
- With the old hook, each nested turn end gives the thread a reply while the
  primary's turn runs, at 74.5 and 77.4 seconds (`first-run/timeline.txt`).
  With the branch's hook, the capture server received nothing from them.
- Its AskUserQuestion prompt reported `session.waiting`, and the tool heartbeat
  after the answer resumed the turn.

## Checks

`typecheck.txt` and `tests.txt` are `npm run typecheck` and `npm test` on the
branch.

## Not verified

- A rebuilt pylon image, and a worker started through the control plane. The
  hook ran from this branch's files, copied into the `verify` user's HOME.
- A dev server reaching the 2-hour cap live. After the cap the session waits,
  which does not keep the pylon awake, so with no other activity the pylon
  pauses and stops the command.
- A Notification with `elicitation_dialog`, which needs an MCP server that asks
  for input.
- Until the image is rebuilt, the old matcher's idle prompt still makes a
  thread `waiting`. The event does not say which notification fired, so the
  control plane leaves every waiting report alone.
