# A deploy's mixed-version window

`verify-mixed-version.ts` ran in this thread's pylon on 2026-10-26, on Node 24.22.1. It replays the deploy that failed a thread with `secret-missing`: a control plane on a release with the ChatGPT login boots a pylon that needs `NEXUS_CHATGPT_TOKEN` on a node whose probe still runs the release before the login, fcf5677, the parent of 989a8f2d (#107). After 20 seconds the probe is stopped and replaced by one from this branch, as `nexus deploy` upgrades it after the control plane.

The control plane is the real reconcile loop and registry from the checkout named first. The probe is the real probe server in a child process, with a secret file that holds only `GH_TOKEN`. Only the VM backend is a stand-in, which boots nothing and reports the pylon running once a spawn reaches it.

| Capture | Control plane | Result |
| --- | --- | --- |
| `control-from-main.txt` | main, 3059974 | The spawn reaches the old probe 2 seconds in, fails with `secret-missing`, and the planner gives up for good: one `thread.failed` event, before the probe is ever upgraded. This is the incident. |
| `control-from-branch.txt` | this branch | The control plane sends no spawn while the old probe runs, because its snapshots carry no `heldSecrets`. The new probe starts at 21.7 s, its first snapshot lists `NEXUS_CHATGPT_TOKEN` in `heldSecrets`, and the pylon boots with the grant at 22.3 s. No attempt is counted and no `thread.failed` event is written. |

```sh
git worktree add --detach /tmp/nexus-old fcf5677 && ln -s "$PWD/node_modules" /tmp/nexus-old/node_modules
git worktree add --detach /tmp/nexus-main 3059974 && ln -s "$PWD/node_modules" /tmp/nexus-main/node_modules
node docs/verification/deploy-mixed-version/verify-mixed-version.ts control /tmp/nexus-main/src /tmp/nexus-old/src
node docs/verification/deploy-mixed-version/verify-mixed-version.ts control src /tmp/nexus-old/src
```

Not verified here: a real `nexus deploy` across `rj-firebat` and `infra-testbench`, and a pylon VM booting with the token. The token handoff is left out, because the boot no longer waits for it: a pylon that boots before the first handoff gets the stand-in that the next one replaces, as before this branch.
