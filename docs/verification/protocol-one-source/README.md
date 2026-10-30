# One source for the peer check, the probe's status errors and the protocol's unions

`run.sh` ran in this thread's pylon on 2026-10-30, on Node 26.12.1, against main at 90f4299 and this branch at 6b38699, the last commit that changes code.

`capture.ts` drives each checkout's real `connectProbe` client, `fetchArtifact`, the deployer's `jsonRequest`, and the LocalAPI whois and certificate reads. A loopback HTTP server stands in for a probe and a peer, a raw TCP server for a node that whois does not name, and a Unix-socket server for tailscaled. The capture writes each answer, or each rejection's class, message, `code` and `status`. It then copies the deployer bootstrap's files, as `deploy/install-deployer.sh` lists them, into a directory with no node_modules and loads `tailscale.ts` and `deploy/http.ts` from there.

| Capture | main | branch |
| --- | --- | --- |
| Every probe status a method gives no meaning, in all eight methods and `fetchArtifact` | `Error` with the message below | `ProbeHttpError` with the same message, `code` only on 403 and on a command's or stream's 409, and `status` |
| 403, and 409 to `command` or `stream` | `forbidden`, `not-running` | The same codes and messages |
| 409 to `putPeers` | No code | No code |
| A peer that whois does not name, to `open`, `stream`, `fetchArtifact` and `jsonRequest` | `forbidden` with today's messages, 0 bytes sent | The same |
| whois failing | `unreachable` from `open`, the error as it is from `stream` | The same |
| whois answering 2 MiB | Read whole, then a JSON error | `tailscaled whois ... response too large` |
| certificate 403, 129 KiB, no pair | Its three messages | The same |
| The deployer bootstrap with no node_modules | Loads | Loads |

`diff.txt` holds the difference: the class name, the added `status`, and whois's new 1 MiB cap. No message changed.

`tests-main.txt` runs the branch's tests of the changed files and the typecheck on main's code, and `tests-branch.txt` runs them on the branch, where all 138 pass and the typecheck is clean. On main, `src/protocol.test.ts` and `src/tailscale.test.ts` fail to load, because main lacks `ProbeHttpError`, the union lists, `PeerRefused` and `verifyPeer`. The typecheck fails on main too, including the two `@ts-expect-error` lines in `src/project.test.ts`, which are unused there because main has no `ParsesTo` to fail. `src/deploy/http.test.ts`'s new test, that a wrong identity gets no byte, passes on main: it pins behaviour this branch keeps.

```sh
docs/verification/protocol-one-source/run.sh            # main is the merge base with origin/main
```

Not checked here: a real tailscaled, and a socket that closes between connect and whois, which the stand-ins cannot time. `src/tailscale.test.ts` drives `verifyPeer` on a socket that never connected.
