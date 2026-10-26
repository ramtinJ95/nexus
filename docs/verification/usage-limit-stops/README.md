# Usage-limit stops verification

Verified in this task's pylon on 2026-10-26, on branch `usage-limit-stops`, with Claude
Code 2.1.308 and Herdr 0.9.5. No live control plane, node, image, Claude subscription or
other thread was touched.

## The records

`fake-api.mjs` answers Claude Code's Messages API requests the way the API answers a
subscription at its limit: a 429 with `anthropic-ratelimit-unified-status: rejected`, a
`-reset` time and a `-representative-claim`. Claude Code reached it through
`ANTHROPIC_BASE_URL`, with a fake `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_MAX_RETRIES=0`,
under a throwaway HOME. `claude -p` printed `You've hit your session limit · resets 7am
(UTC)` with `api_error: usage_limit_reached`. The records it wrote are
`src/fixtures/claude-api-errors.jsonl`, in order: the session limit (`five_hour`), the
weekly limit (`seven_day`, `resets Oct 29, 5:30am (UTC)`), a 429 without the unified
headers (`error: rate_limit`, no `apiError`, text "(not your usage limit)"), and a 529
(`error: server_error`). A usage limit is the only one with `apiError:
"usage_limit_reached"` and `apiErrorParams.rate_limit_info.resetsAt`, in Unix seconds.

An interactive worker wrote more, kept in `src/fixtures/claude-usage-limit-session.jsonl`:
`system/informational` "Usage limit reached · continuing automatically at 5:54am · esc to
cancel", then, 93 seconds after the reset, its own continue. That continue is a queue
operation, a second informational "Usage limit reset · continuing automatically", and a
`user` record with `isMeta: true` and `origin.kind: "auto-continuation"`, which the parser
dropped before this branch. While the fake API kept refusing, Claude continued again once
a minute.

## The stack

`stack.ts` is [the turn snapshots stack](../claude-turn-snapshots/README.md), with these changes:

- It is moved to 127.0.0.1:7473, the bridge to 7491, Herdr server `verify-limit` and
  `/tmp/nexus-limit-verify`.
- It runs the real registry, API and dashboard, and a real interactive Claude Code worker,
  launched and messaged through the real `runCommand`.
- The worker reaches `fake-api.mjs` on 18767 with a fake login. The driver switches the fake
  API between the limit and a short streamed reply.
- The hooks are the image's, with this branch's StopFailure hook. `HOOKS=old` leaves it out,
  as the current image does.
- The opt-in resumer runs every 2 s through the real `agentInbox` and `runCommand`. Its grace
  is 5 s, not 3 minutes, so a run takes minutes.

`drive.mjs` drives it through the CLI, `node src/cli/nexus.ts` with `NEXUS_URL` and
`NEXUS_SOCKS=none`, and saves the dashboard's pages as the HTML the control plane renders.
This pylon lacks the shared libraries headless Chromium needs (`libnspr4`), and its package
mirrors are not reachable, so there are no screenshots.

## What was checked

- `01-threads.txt`, `01-thread-row.json`, `01-show.txt`. Four seconds after the start, the
  thread whose turn hit the limit has `attention: "limited"` and `usageLimit` with the fake
  API's reset. `threads` shows `stopped on its usage limit until 06:31 UTC` in place of
  `working`, and `show` prints the attention and a `usage limit:` line saying how to resume.
  A `seen` left it `limited` (`drive.log`).
- `01-conversation.txt`, `01-conversation.json`. The transcript shows the error, Claude's
  own "continuing automatically" notice, and a last line saying to send "continue" after the
  reset. The JSON carries `usageLimit`.
- `01-home.html`, `02-thread.html`. The dashboard's home row and the thread page show the
  state "stopped on its usage limit until 06:31 UTC" with the bad tone (`drive.log` lists
  each page's states).
- `03-events.jsonl`, `03-conversation.txt`, `03-continued.html`. Six seconds after the
  reset, the resumer typed its attributed continue once. The `usage-limit.continued` event
  names the session, the stop, the reset and the request ID. The turn it started answered,
  and attention went `working` then `reply`. Ten seconds later there was still one event.
  The thread page shows "new reply". The StopFailure hook reported `session.turn-ended`
  380 ms after the turn started. Attention showed `reply` for 762 ms, until the transcript
  read found the stop.
- Several minutes after the reset, the thread still ended on that one continue. Claude
  Code's own continue did not follow, because the Nexus prompt had already started a turn.
- `04-send.txt`, `04-conversation.txt`. A second thread, whose reset was an hour away so the
  resumer left it, was continued by hand with `nexus send <thread> continue`. It answered,
  with no `usage-limit.continued` event.
- `05-archived.txt`. A third thread, archived while stopped, still shows `limited` 20 s past
  its reset and got no continue.
- `06-old-hooks.txt`. With `HOOKS=old`, no turn end is ever reported. The read that found the
  stop ended the session's lease. The thread went from `working` to `limited` in 4 s, with no
  `sessionTurnRunning` and no reply recorded.

A first run showed a flash of `limited` after the continued turn ended, while the read of
its prompt was still pending. That would have notified the dashboard at once. A stop now
counts only while no turn started after it, and the run above shows no flash.

## Not verified

- A real subscription at its real limit. The fake API sends the headers the binary reads,
  and Claude Code composed its own records from them.
- A rebuilt image with the StopFailure hook, and a worker on a real pylon.
- A pylon that paused while stopped and was woken by the resumer. The stack's wake is a
  no-op and its pylon never pauses. The inbox's wake is the PR watch's and the review
  loop's, and their tests cover it.
- Claude Code's own continue racing the resumer's at the real 3-minute grace. The stack's
  5-second grace let the resumer go first.
