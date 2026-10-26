# A Claude launch across a probe restart

`verify-restart.ts` ran in this thread's pylon on 2026-10-26, with Claude Code 2.1.308 and Herdr 0.9.5. Each run starts the real control loop and registry with one Claude worker thread, and the real probe server in a child process on a loopback port. The probe stops itself with SIGTERM at one step of the launch, as a deploy's restart does, and the script starts a replacement 1.3 seconds after it exits. Only the VM backend is a stand-in: it reports one running pylon whose guest is this machine. Herdr and Claude run for real in a scratch HOME under `/tmp/nexus-restart-<case>`, so their server, sessions and Claude state are separate from the pylon's own. Claude uses the pylon's token placeholder and answers the prompt "Reply with exactly the words: restart verified".

Each capture shows the probe exit, the replacement listening, the control plane sending the launch again, the worker `started` with no `thread.failed` event, one Claude process in the scratch HOME, the pane's screen with Claude's reply, and the launch record in `~/.nexus/claude-launches/<session>/`.

| Capture | Probe stopped | Stopped probe's code | Result |
| --- | --- | --- | --- |
| `before-typing.txt` | waiting for the pane's shell prompt | this branch | the replacement typed into the same pane: 1 workspace, 1 Claude |
| `while-typing.txt` | right after the exec that types the launch started | this branch | the replacement typed nothing and found the receipt: 1 workspace, 1 Claude |
| `after-typing.txt` | waiting for the receipt | this branch | the same as while typing |
| `before-typing-from-main.txt` | waiting for the pane's shell prompt | main | main's probe records nothing, so the replacement opened a second workspace and typed once: 2 workspaces, 1 Claude, and main's pane is left as an empty shell |
| `while-typing-from-main.txt` | right after `herdr pane run` started | main | the replacement found Claude running the session and typed nothing: 1 workspace, 1 Claude |
| `after-typing-from-main.txt` | waiting for the receipt | main | the same as while typing |

The `-from-main` runs are the deploy that ships this change: the probe a deploy stops runs the old code. Run them with the `src` directory of a checkout of main as the second argument:

```sh
node docs/verification/launch-survives-deploy/verify-restart.ts before-typing
git worktree add --detach /tmp/nexus-main origin/main && ln -s "$PWD/node_modules" /tmp/nexus-main/node_modules
node docs/verification/launch-survives-deploy/verify-restart.ts before-typing /tmp/nexus-main/src
```

Not verified here: a probe restart on a real node with a pylon VM, and a control plane restart during a launch, which only the unit tests in `src/control/loop.test.ts` cover. The fix for "Guest command could not start" in `src/pylon-vm/processes.ts` needs a Gondolin VM, so only its unit test covers it.
