# Pipe helpers

`run.sh` runs `stack.ts` on main and on this branch. `stack.ts` starts the real probe server (`src/probe/server.ts`) and reaches it with the control plane's real probe client (`connectProbe` in `src/protocol.ts`), whose `stream` puts argv in the request URL. The pylon is a local process per stream. Through that it runs the usage read, a checkout listing, a transcript read and a 300 KiB terminal paste, and prints the URL-encoded `request` query of each stream it opens. Each worktree runs twice: with `src/agent-usage.py` as committed, and with it grown by 12 KiB of comment.

- `main.txt`. The usage read sends its 4,645-byte helper in argv, which is an 8,100-byte query today. Grown to 17,068 bytes, the query is 21,384 bytes and the probe's Node server refuses the request with HTTP 431, so usage counting fails with a probe request error.
- `branch.txt`. Every helper goes on stdin through `openPython`. The usage read's query is 575 bytes, 576 after the helper grows, and it reads the same 11 calls. The checkout listing's query grows from 114 to 645 bytes because argv now carries the bootstrap, and stays far below `pathsFit`'s 8,192.
- The paste reaches the program with the SHA-256 it was sent with on both. Its speed is not measured here: the reader sleeps half a second before reading, which dominates the time.
