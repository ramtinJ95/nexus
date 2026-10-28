# nexus connect

Verified in this thread's pylon on 2026-10-28, on branch `feat/nexus-connect` from main at `ba88ff5`, with Node 26.12.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
node docs/verification/nexus-connect/capture.ts > docs/verification/nexus-connect/transcript.txt
```

It needs port 7470 free. The fresh HOME reads `<home>` in the transcript.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not build its pylon image or start its probe. `capture.ts` starts the rest of that stack as `scripts/stack.ts` does: the real `startControlPlane` on `127.0.0.1:7470`, behind the stack's fake tailscaled, whose whois names every caller as the laptop `nVERIFYLAPTOP`, with no deployers. `connect`, `projects` and `threads` need no pylon. It drives the real `deploy/mac/nexus` shim with only `PATH` and a fresh `HOME`, so no `NEXUS_URL`, `NEXUS_SOCKS` or config file.

## What [`transcript.txt`](transcript.txt) shows

| Step | Result |
|---|---|
| `threads` before connecting | exit 64, `no control plane is set. Run nexus connect <host> ...`. No URL is built in |
| `connect 127.0.0.1` | exit 0. `https://127.0.0.1:7443` refused the connection, so it saved `http://127.0.0.1:7470`, and it says the laptop may read and act as a person but not deploy, with the line that would make it a deployer |
| `cli.json` | `{"url": "http://127.0.0.1:7470"}`, with no proxy, since none was set or given |
| `project add`, `projects`, `threads`, `threads --json` | exit 0, through the saved URL alone |

## Not verified here

- The real tailnet: tailscaled's whois of a real Mac, MagicDNS names through ts-home's SOCKS proxy, and the control plane's real `listen.hostnames`. `connect` to `rj-firebat` was not run.
- HTTPS against the real dashboard certificate. `src/cli/nexus.test.ts` covers TLS on the dashboard's port with a test certificate the CLI trusts through `NODE_EXTRA_CA_CERTS`, and its fallback to HTTP when the certificate is not trusted, but not the certificate tailscaled issues or how a Mac trusts it.
- `deploy/mac/install` on macOS. It ran from a fresh clone on this Linux pylon.
