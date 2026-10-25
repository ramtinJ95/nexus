# Claude background subagent and multi-line launch verification

Verified in this task's pylon on 2026-10-25 with Claude Code 2.1.308 and Herdr
0.9.5, starting from main `7a34894`. All runs used an isolated Herdr server,
`ml-test`, and fresh HOMEs under the session scratchpad. No production hooks
ran, nothing reached the live control plane, and no image was built.
Each pane shell sourced `/etc/profile.d/nexus-secrets.sh` for the per-boot
`CLAUDE_CODE_OAUTH_TOKEN` placeholder. No token is in these captures.

## Which hooks fire around a background subagent

The test HOME logged every hook's input with a small logger. The prompt asked
Claude to start one general-purpose subagent with `run_in_background: true`,
tell it to run sequential slow Bash calls, and end its turn at once.

Observed on every run (`hooks.jsonl` holds the full inputs of the final run):

- SubagentStart fires when the Agent tool starts the subagent, with `agent_id`
  and `agent_type`.
- The main Stop fires about a second later. Its input lists the subagent in
  `background_tasks` as `{"type": "subagent", "status": "running", ...}`.
- The subagent's PreToolUse and PostToolUse hooks carry the main `session_id`,
  plus `agent_id` and `agent_type`.
- SubagentStop also fires for internal helper agents with an empty
  `agent_type` and no SubagentStart, every few seconds to minutes. One such
  agent also ran a PreToolUse with its own `agent_id`.
- When the subagent finishes, its SubagentStop fires. Within 80 ms Claude
  submits a `<task-notification>` prompt, so UserPromptSubmit fires and a new
  main turn starts. That turn's Stop has `background_tasks: []`.
- No Notification fired while the main prompt sat idle waiting for the subagent.

An earlier run also started a `sleep 90` with Bash `run_in_background`. It shows
in `background_tasks` as `{"type": "shell", ...}`, and its completion starts
another task-notification turn of its own.

So the Stop hook's own input says whether background subagents still run, and
Claude ends the work with an ordinary turn. The image's hook reports a heartbeat
for a Stop that lists a running subagent, instead of a turn end.

## End to end through the new hook

`capture-server.mjs` stood in for the pylon API. The test HOME had the image's
hook table, pointing at this branch's `images/pylon/nexus-claude-hook`, beside
the logger. The pane had `NEXUS_API=http://127.0.0.1:47811`, so the installed
`nexus event` CLI posted to the capture server. `events.jsonl` is what it
received.

The subagent ran 8 sequential `python3 -c "import time; time.sleep(45)"` calls.
Claude Code refuses a foreground `sleep 50`, which ended the first attempt after
5 seconds. That attempt's Stop also reported no turn end.

`timeline.txt` is `node replay.ts events.jsonl hooks.jsonl`. It replays the run
into a fresh registry at the captured receipt times, once as the old hook would
have reported the raw inputs and once as the new hook did.

The subagent ran for 6m 13s (`pane.txt`). With the old hook, attention turns to
`reply` 3.5 seconds in, while the subagent has 6 minutes left, and the
subagent's heartbeat at 328 seconds is ignored because no turn runs. That is
what th-03f8c19b1441 saw. With the new hook, the main Stop at 3.5 seconds sends
nothing, because the Agent tool's heartbeat a second earlier holds the
five-minute throttle. The session stays `working`. The subagent's own tool
heartbeat at 328 seconds renews the lease. Attention turns to `reply` only at
the Stop of the task-notification turn, 377.7 seconds in.

`earlier-runs/` holds the logger's inputs from the two exploratory runs: one
background subagent alone, and a subagent beside a background shell.

## Multi-line first prompts

`herdr-refusal.txt` shows the cause. Herdr's `agent start` refuses any agent
argument holding a newline, tab or carriage return with `invalid_agent_argument`.
A single-line argument with quotes, backticks and `$HOME` passes. Before this
change, `startHarness` read any error from a prompted launch as uncertain, waited
30 seconds for a receipt that could not come, and reported a stall with only the
shell prompt in the pane, as in th-eaaf5d544495.

`verify-launch.mjs` runs the patched `openSession` against real Herdr and Claude,
moving only HOME, the checkout and the Herdr server name, like
`../claude-worker-launch/verify-launch.mjs`. The workspace starts with HOME set,
so the fresh pane's bash runs the test HOME's `.bashrc`, which sources the real
one and the token placeholder. Nothing else is typed into the pane and nothing
waits before `openSession`. The test HOME logs UserPromptSubmit input. The first
prompt is 5,227 bytes over 48 lines, with blank lines, a tab, quotes, backticks,
`$HOME`, `$(...)`, `${PATH}` and `!!`. Its typed command is 6.5 KB on one line.
These runs used an isolated Herdr server, `exp`.

Typing a line into a pane is safe only once bash reads it with readline. Before
that, as while bash runs its startup files, the terminal is in canonical mode,
and its line discipline drops input past 4 KB on one line. So `startHarness`
waits, up to 10 seconds, until the shell's process group holds the terminal and
the terminal is out of canonical mode (`stty -a` shows `-icanon`). A shell that
never gets there fails the launch before anything is typed, with the pane's
screen, and the workspace rolls back.

- `launch.txt` is a cold launch. The gate cleared 4 ms after it started, Claude's
  UserPromptSubmit input equals the first prompt byte for byte, and Claude
  answered. `openSession` returned 1.2 seconds after starting, on the receipt.
- `launch-slow-startup.txt` is the same launch with a `.bashrc` that first sleeps
  2 seconds, a synthesized slow startup. The gate waited 2.05 seconds, then the
  prompt arrived exactly.
- `launch-slow-startup-before.txt` is that slow startup with `src/sessions.ts`
  from before the gate. The command was typed 30 ms after starting, the terminal
  cut it, and bash sat at a `>` continuation prompt. Claude never started, and
  the launch stalled after 30 seconds.

## Checks

`typecheck.txt` and `tests.txt` are `npm run typecheck` and `npm test` on the
branch.

## Not verified

- A rebuilt pylon image, and a worker started through the control plane. The
  hook and launch ran from this branch's files inside the current pylon.
- A subagent that runs longer than the 30-minute lease without a tool hook. The
  registry tests cover expiry.
- Shells other than bash. The pylon user's shell is bash, and the typed
  command uses bash ANSI-C quoting.
