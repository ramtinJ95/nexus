# API boundary verification

Verified in this thread's pylon on 2026-10-29, on branch `simplify/w1-api-boundary` against main at `c5168d6`, with Node 26.12.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/api-boundary/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees and copies `control.ts` and `drive.sh` into each. In each tree it starts `control.ts`, runs `drive.sh` against it and stops it. The transcripts land in `main.txt` and `branch.txt`. Both runs use the same files and the same steps, so the transcripts differ only by the code under test. `RUNS=main` or `RUNS=branch` runs one of them.

## The stack

`control.ts` is the real `startControlPlane` of the checkout under test, on plain HTTP at 127.0.0.1:7470. Its one stand-in is tailscaled's whois. It names every caller the person's Mac `nLAPTOP`. While `$WORK/stranger` exists it names them `nSTRANGER`, which no allowlist holds. Its node has no probe, so nothing reaches a pylon. `drive.sh` asks the API with curl and the checkout's own CLI.

## Main and this branch

| Request | main, c5168d6 | this branch |
|---|---|---|
| `GET /v1/%zz` from the allowed laptop | 500 `URI malformed` | 400 `the request path "/v1/%zz" is not a valid URL path` |
| `GET /v1/%zz` from a stranger | 500 `URI malformed`, before the allow check | 403 `caller is not a tailnet node this control plane allows` |
| `GET /v1/projects` and `/v1/whoami` with `Host: [zz` | 500 `Invalid URL` | 403 `the API does not answer to host [zz` |
| `GET /v1/no-such-route` | 404 `{"error"}` | 404 `{"error", "code": "no-route"}` |
| `POST /v1/threads` as `text/plain` | 415 | 415, the same text, now from `requireJson` |
| `nexus connect`, then the config's mode | 644 | 600 |
| `nexus show <missing> --json` stderr | `{"error","kind","status"}` | the same with `"code": null` |
| `--secret gh_token:...` and `GH_TOKEN:localhost` | exit 64 | exit 64, the same text, now from project.ts's patterns |
| A config with `"ssh"` | `is not a CLI config: ✖ Unrecognized key: "ssh"` | `is not a CLI config: config: Unrecognized key: "ssh"` |

## Not checked here

`nexus send` to a Claude worker that waits at a prompt needs a pylon whose Herdr runs Claude Code, which this stack has none of. The test `send to a Claude worker that waits at a prompt in its terminal fails at once with exit code 5, and is typed once` in `src/cli/nexus.test.ts` runs the real CLI against the real API with a probe client that answers `blocked`. On main it times out sending once a second.
