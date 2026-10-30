# A stalled Claude launch crosses the probe as data

`verify-stall.ts` ran in this thread's pylon on 2026-10-30, with Herdr 0.9.5. Each run starts the real control loop and registry with one Claude worker thread, and the real probe server in a child process on a loopback port. Only the VM backend is a stand-in: it reports one running pylon whose guest is this machine. Herdr runs for real in a scratch HOME under `/tmp/nexus-stall-<case>`. `claude` on the pane's PATH is a script that prints a line and sleeps, so the launch's UserPromptSubmit receipt never comes and the launch stalls after 30 seconds.

| Capture | Probe | Result |
| --- | --- | --- |
| `branch.txt` | this branch | the probe answers the open-session command with `stalled`, and no tick fails. The worker is `stalled`, with the pane's screen in its message, one `thread.failed` event, failed attention, and its pane left open |
| `main-probe.txt` | main | main's probe answers HTTP 500 with the stall's text, and this branch's control plane records the worker `failed`, with the same screen, event, attention and open pane. A node keeps doing this until its probe updates |

```sh
node docs/verification/launch-stall-as-data/verify-stall.ts
git worktree add --detach /tmp/nexus-main origin/main && ln -s "$PWD/node_modules" /tmp/nexus-main/node_modules
node docs/verification/launch-stall-as-data/verify-stall.ts /tmp/nexus-main/src
```

The first run also showed that Herdr 0.9.5's `pane read` prints the pane's text, not a JSON reply, so the stall's screen comes from that text. The unit tests' Herdr fakes now print it the same way.

Not checked here: a real Claude Code that stalls, a pylon VM, and the dashboard's view of a stalled worker.
