# Claude Code onboarding verification

Verified on the current pylon, Claude Code 2.1.308, without changing its image,
control plane, or other threads. `AGENTS.md` was absent. Git identity was present.

First reproduced with a Python PTY and a fresh HOME. Then repeated in a separate
Herdr server named `onboarding-verification`, using `/tmp/nexus-claude-before`
as HOME and `/tmp/claude-test-checkout` as cwd. The numbered text files are
`herdr pane read --source recent-unwrapped --lines 40` captures, before answering
each screen. Enter accepts the theme/security notes; Down then Enter accepts
trust/bypass. The default theme is dark.

Observed writes after accepting the screens:

- `.claude.json`: `hasCompletedOnboarding: true` (also writes a version stamp).
- `.claude/settings.json`: `theme: "dark"`.
- `.claude.json`: `projects[realCheckoutPath].hasTrustDialogAccepted: true`.
- `.claude/settings.json`: `skipDangerousModePermissionPrompt: true`.

Trust was not persisted when cwd was HOME itself; the separate checkout test
persisted it. Nexus trusts the real checkout path, not all directories.
No OAuth credential confirmation appeared with the granted
`CLAUDE_CODE_OAUTH_TOKEN` placeholder. No credentials were copied into the test
homes or saved in these captures.

For the after test, created another HOME, `/tmp/nexus-claude-verify`, copied the
installed plugins and plugin settings (without the production hooks, to avoid
sending test events to the current thread), and ran the actual `seedClaudeState`
script. Launched in Herdr with:

```
claude --session-id <fresh UUID> --permission-mode bypassPermissions \
  --settings '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"touch /tmp/nexus-onboarding-submitted"}]}]}}' \
  '/poteto-mode say hello and stop'
```

No keystrokes were sent after launch. `after.txt` shows the expanded pstack
command, “Hello. Stopping here as asked.” and the ready prompt. The local
UserPromptSubmit receipt existed. The production implementation uses a unique
receipt per launch and preserves the existing event hooks.

Not verified: the historical image img-d7c6b7aa22ed or its exact Claude version;
no image was built or switched. A live control-plane `nexus start` was deliberately
not run. Registry/event/attention propagation and stalled launches are covered
by tests instead. No claim is made that future Claude releases cannot add gates;
the bounded submission check makes those visible rather than silently started.
