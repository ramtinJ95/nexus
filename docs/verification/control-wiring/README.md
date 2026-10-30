# The control plane's turn gate, poll timers, node lookup, error statuses and peer puts

`run.sh` ran in this thread's pylon on 2026-10-30, on Node 26.12.1, against main at ccc2f2e and this branch at 483c483, the last commit that changes code.

`capture.ts` starts each checkout's control plane through `startControlPlane`, as `main.ts` wires it, on loopback, with a fake tailscaled. Each node's probe is the real `connectProbe` client. rj-firebat's points at a loopback stand-in that streams the snapshots the capture sends, counts `PUT /v1/peers` and answers the node-health read with 403. infra-testbench's points at a closed port. The capture writes what the API answers, and how many peer lists reach rj-firebat after each snapshot.

| Capture | main | branch |
| --- | --- | --- |
| Node health, probe answers 403 | 500 | 502 |
| Node health, probe down | 503 | 503 |
| Deployer report with its own key, with another node's | 200, 403 | 200, 403 |
| whoami as the Mac, the control node, a node | person and deployer, neither, neither | The same |
| Peer puts after snapshots of boot-1, boot-1, boot-1, boot-2 | 1, 2, 3, 4 | 1, 1, 1, 2 |
| Events since an expired cursor | 409 | 409 |
| Events with the `events` table dropped under the running control plane | 409 | 500 |

`diff.txt` holds the difference. The messages are unchanged.

`tests-main.txt` runs the branch's tests of the changed files on main's code, and `tests-branch.txt` runs them on the branch, where all 335 pass. On main, 16 fail: the three new API status tests, the drain test that passes a gate into `startApi`, the registry's `nodeByTailnetId` test, the two peer-put tests that need the boot ID, and chatgpt-token's tests, which pass `probes` as a function, the new one that a node joining later gets the token among them.

```sh
docs/verification/control-wiring/run.sh            # main is the merge base with origin/main
```

Not checked here: a turn held in main's gate during a real deploy's drain, which `src/control/api.test.ts` drives through `startApi`, and that the poll timers no longer hold the process open, which only shows once the API's server has closed.
