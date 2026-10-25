# Claude worker launch verification

Verified in this task's pylon on 2026-10-25, starting from main `2171210`.
Installed Claude Code: 2.1.308. No live control-plane calls, image changes,
deployments, pushes from Claude, or changes to other threads were made.

## Readiness timeout and survival

`herdr-start-help.txt` shows the installed CLI's only start wait condition:
interactive readiness. There is no no-wait switch or first-submission condition.
Used an isolated Herdr server `launch-verification`, a fresh HOME at
`/tmp/nexus-launch-home`, and a scratch checkout `/tmp/nexus-launch-repo`.
Seeded HOME with the actual `seedClaudeState` via `node -e`. No production hooks
were copied, so these runs did not send lifecycle events into this task's thread.
The shell in each new test pane exported the isolated HOME before agent start.

The first experiment (`start-timeout.txt`, `busy.txt`) asked for a single
`sleep 65`. Claude backgrounded that command and returned to idle, so it did not
reproduce the bug. Kept the capture rather than calling this a reproduction.

The successful reproduction used:

```
herdr --session launch-verification agent start busy2 --kind claude \
  --pane w2:p1 --timeout 30000 -- --permission-mode bypassPermissions \
  --settings '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"touch /tmp/nexus-launch-receipt-2"}]}]}}' \
  'Perform exactly 15 sequential Bash tool calls. In each run sleep 4; echo step-N with the appropriate N. Do not combine calls, do not background them. After all 15 say done.'
```

`start-timeout-2.txt` records Herdr's `timeout` and the receipt's presence.
`busy-2.txt` shows Opus still executing step 5 at the deadline.

`verify-launch.mjs` invokes the actual patched `openSession`, with a local Guest
adapter redirecting only HOME, checkout paths and Herdr server name. It does not
mock Herdr or Claude. `fixed-launch.txt` records the same Herdr timeout followed
by successful return of pane w3:p1, still busy. `fixed-completed.txt` shows all
15 steps completed after 1m37s; the pane remained open. The helper's absolute
checkout import is specific to this pylon; adjust it for another checkout.

## Attribution and model

Seeded native settings were `model: "claude-opus-5-5"` and
`attribution: { commit: "", pr: "" }`. Inspection of the installed binary's
settings schema also describes an empty attribution string as hiding attribution.
An actual Claude print-mode run, with that isolated HOME and the OAuth
placeholder already granted to this pylon, created hello.txt and committed it in
the scratch repository. `commit.txt` is its complete commit metadata/message:
no Co-Authored-By trailer. It then invoked `gh pr create --title ... --body ...`.
A PATH-local shim captured arguments to `pr-dry-run.txt` and made no network
requests; the PR body has no footer. The shim was:

```sh
#!/bin/sh
if [ "$1 $2" = 'pr create' ]; then
  printf '%s\n' "$@" > /tmp/nexus-verify-pr-args
  echo 'Dry run: arguments captured locally; no request sent.'
else
  echo 'Dry-run GitHub shim: no network calls permitted.'
fi
```

`model.json` contains the response's model usage and result, not credentials or
raw transcripts. It confirms `claude-opus-5-5`: **this token can use Opus 5.5**.
A second real call with `--model claude-sonnet-5-5` produced
`model-override.json`, confirming an explicit override wins over seeded Opus.
This proves requested and usage model IDs for these runs, not all subscription
tiers or future entitlement changes.

## Automated coverage and limits

Tests exercise readiness timeout with receipt, live busy-process fallback,
missing receipt and disconnected receipt reads, no resubmission, late RPC errors
after submission, persisted diagnostics, API/CLI/dashboard views through a real
SQLite registry, model overrides, merge preservation and checkpoint relaunch.
The tests use local fake probes; no deployed registry was changed. Full suite
and typecheck results accompany the captures. The pylon has Node 24.22.1; the
repository recommends Node 26, which was not installed or switched for this task.

No actual GitHub PR was created by the verification Claude, and no real pylon
checkpoint/wake or deployed `nexus start` was performed. Those paths are covered
by tests, not claimed as live verification. All real test agents finished before
the isolated verification server was stopped.
