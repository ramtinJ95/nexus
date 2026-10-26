# A start right after a restart

`stack.ts` ran in this thread's pylon on 2026-10-26, on Node 24.22.1. It starts threads of a project with the `chatgpt` login and the default node `auto` with the real `nexus start` CLI on a two-node local stack, at four moments: on a new stack, right after a control plane restart, right after a deploy, and right after both probes restart. In the deploy, the control plane restarts and then both probes do, 3 seconds later, because `nexus deploy` upgrades the control plane first. A start that is refused is tried again every 5 seconds.

The control plane is the real `startControlPlane`, with its registry, loop, harness, API and token handoff. Each node is the real probe server in its own process, on 127.0.0.1 and 127.0.0.2, so a restart is a process exit. Only the production boundaries are stand-ins: tailscaled's whois, the scripted model, a fixed token in place of the harness's ChatGPT login, and a VM backend that boots nothing. The backend logs whether the probe would boot the pylon with the handed-over token or with the unusable stand-in. The stand-in backend forgets its pylons when its probe exits, so a restarted probe also boots again the threads it ran before.

| Moment | `main.txt`: main, bd1335d | `branch.txt`: this branch |
| --- | --- | --- |
| New stack | Refused 11 times with `no node can run this pylon: node-a has no secret NEXUS_CHATGPT_TOKEN from the control plane yet; node-b ...`. Accepted 62.3 s after the first try. | Accepted at once. The pylon boots with the token 0.4 s after the start. |
| Control plane restart | Accepted at once, because the probes still hold the token. | The same. |
| Deploy | Accepted, because the control plane had not yet seen the new probes' snapshots. Every pylon on the node, the new one too, boots with the stand-in, so its first requests to `api.openai.com` would be refused. | Accepted at once. Every pylon boots with the token 1.3 s after the start. |
| Probe restart | Refused 11 times. Accepted 62.3 s after the first try. The pylons that were running boot again with the stand-in. | Accepted at once. Every pylon boots with the token, the new one 0.5 s after the start. |

```sh
git worktree add --detach ../nexus-main bd1335d && ln -s "$PWD/node_modules" ../nexus-main/node_modules
node docs/verification/start-right-after-restart/stack.ts drive ../nexus-main/src
node docs/verification/start-right-after-restart/stack.ts drive src
```

On main, a refused start waits for the handoff's next 60-second tick. The token then reaches the control plane only with the probe's next 60-second snapshot. Two unaligned timers allow about two minutes, which fits the 2m24s seen live, but that live figure was not reproduced here.

Not verified here: a real `nexus deploy` across `rj-firebat` and `infra-testbench`, and a pylon VM that boots and makes a request with the token.
