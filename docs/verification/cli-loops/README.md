# CLI loops and connection verification

Verified in this thread's pylon on 2026-10-30, on branch `simplify/w4-cli-loops` against main at `74c09ae`, with Node 26.12.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/cli-loops/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees and copies `control.ts` and `drive.sh` into each. In each tree it starts `control.ts`, runs `drive.sh` against it and stops it. The transcripts land in `main.txt` and `branch.txt`. `RUNS=main` or `RUNS=branch` runs one of them. The main run takes about a minute longer, because its orphaned watch waits out its interval.

## The stack

`control.ts` is the real `startControlPlane` of the checkout under test, on plain HTTP at 127.0.0.1:7470, with a current image in its registry so a thread starts. Its node has no probe, so no pylon boots. A SOCKS5 proxy at 127.0.0.1:7471 alone resolves `nexus.verify`, as ts-home's proxy alone knows MagicDNS, and writes a line for each CONNECT. `drive.sh` runs the checkout's CLI through it and prints each command's answer, exit code and CONNECTs.

## Main and this branch

| Step | main, 74c09ae | this branch |
|---|---|---|
| `item add --after ,` | sent, and the API answers 409 only because this stack has no GitHub token | exit 64 `--after needs a thread`, 0 CONNECTs |
| `item add --model` without `--claude` | exit 64 `--model requires --claude` | the same |
| `watch` at `--interval 250` for 6 s | 22 CONNECTs, one per poll and the stream's | 2 CONNECTs, the polls' and the stream's |
| `threads` | 2 CONNECTs, one after the other | 2 CONNECTs, at once |
| `watch --interval 60000` whose parent is killed | exits after 60 s | exits within 2 s |
| `events --follow` whose parent is killed | exits within 2 s | within 1 s |
