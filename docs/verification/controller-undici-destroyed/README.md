# A controller crash on undici's ClientDestroyedError

Run in this task's pylon on `infra-testbench` on 2026-10-26, on branch `controller-undici-destroyed`, with Node 24.22.1 (the pylon image's Node). No live control plane, node or other thread was touched. "Main" is a worktree of `origin/main` at `8bfb357` with its own `npm ci`, so it runs undici 6.29.1. The branch runs undici 7.30.1.

## The cause

The controller loads undici only through Gondolin's HTTP egress bridge. The bridge keeps one undici `Agent` per upstream origin, with 16 connections, and evicts an origin's Agent with `close()` when a request to it fails, when a response body fails mid-stream, or when a guest closes a flow before its reply ends. The eviction ignores the promise `close()` returns.

In undici 6.29.1, a pool that closes while requests wait in its queue closes all its connections each time one of them drains, and it never catches that promise. When a connection that already finished closing is closed again, `close()` rejects with `ClientDestroyedError`. Nothing holds that promise, so Node ends the process. That rejection is created at `dispatcher-base.js:82`, the line in the thread's controller.log. undici 7 and later skip connections that are already closed.

A pool queues only when all 16 of its connections are busy. With 12 or 16 concurrent guest requests to one origin per round, 150 rounds gave no rejection. With 20, the same 150 rounds gave 15.

## Captures

- `bridge-crash.txt` is `node bridge-stress.mjs 150 --crash` from the repository root. It loads Gondolin's own `QemuNetworkBackend` and feeds it raw guest HTTP for up to 30 flows per round to a local upstream. The upstream resets some connections, the IP policy refuses some connects, and the guest closes some flows early. Without a rejection listener, as in the controller, main exits with status 1 and prints the same error as the thread's controller.log. The branch completes all 150 rounds and exits with status 0.
- `bridge-stress.txt` is the same run with a listener that counts the rejections: 22 `ClientDestroyedError` on main and none on the branch. Both serve the same mix of 200, 403 and 502 replies.
- `regression-test.txt` is the new test in `src/pylon-vm/network.test.ts`. It fails on main in under a second with the same error and passes on the branch.
- `egress.txt` is `node egress.ts`. It sends requests through the bridge with Nexus's own `networkOptions` hooks on both versions: a real request to `api.github.com` that redirects to HTTPS, a POST whose body the guest sends in two parts and whose secret placeholder reaches its host as the value, and a host outside the allowlist, refused with 403. The results match. GitHub sends `/zen` chunked on some runs and with a length on others, on either version.

## What was not verified

- A real pylon VM on this branch. This pylon has no KVM or QEMU, so the bridge ran on its own, fed by the scripts, not by a guest kernel. After a deploy, a pylon that sends more than 16 concurrent requests to one host while some of them fail should keep running.
- The exact burst that crashed thread th-c1ec18a6f71a. The thread's logs do not name the origin. The crash needs more than 16 concurrent requests to one origin and an eviction of that origin. A Claude worker's turn had started, and pi was signed in to ChatGPT. Which host received the burst is an inference that no capture supports.
- Node 26, which the nodes run. The full suite and every capture here ran on Node 24.22.1.
