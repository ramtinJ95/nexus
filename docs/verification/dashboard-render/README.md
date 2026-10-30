# Dashboard render verification

Verified in this task's pylon on 2026-10-30, on branch `simplify/w2-dashboard-render` at 9291969, against main at
b636ea9. The branch's commit b72a020 differs from 9291969 only in two comments. The runs used Node v26.12.1 and headless Chromium 153. No live control plane, node, image or other thread was
touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/dashboard-render/run.sh origin/main <branch-commit>
```

`run.sh` checks out both commits into two worktrees, builds the dashboard in each, copies `drive.ts` and `bench.ts` into
each and runs them there, so the two runs differ only by the code under test. Each run's output lands in `main/` or
`branch/`.

`drive.ts` starts the real registry on a SQLite file, the real API and the real dashboard, with the fake model harness
the API tests use. Two nodes are registered. `verify-node` holds a fresh control report and a probe report two minutes
old. `tower` holds none. One harness thread has 82 messages and a Bash call that runs. Chromium then:

- reads the sidebar's release lines,
- opens the start dialog, picks the Nexus agent, types a title and a branch, picks `tower` and the scratch project,
  then adds a project, so the next poll swaps the dialog's region,
- opens the harness thread's page, whose stream follows the conversation, grows the call's output, and records what
  each `?streaming=1` poll carried in its conversation region.

`bench.ts` times `liveFrames` on a 400-message conversation, 100 turns of a prompt, a reply with a Bash call, its
result and a closing reply, while an answer streams: 300 frames, each a new view of the same entries with a longer
partial answer. It runs three times per commit.

## Results

The sidebar's release lines, as `text (title)`:

| main | branch |
| --- | --- |
| tower: none | tower: `probe: unknown · pending (no deployer report)` |
| verify-node: `control: cccccccccccc · healthy ()` | verify-node: `control: cccccccccccc · healthy ()` |
| verify-node: `probe: cccccccccccc · stale ()` | verify-node: `probe: cccccccccccc · pending (deployer report is stale)` |

The branch's lines are `GET /v1/release`'s view. The control line shows on the same node on both.

The start dialog is the same on both. Its hint after opening, after the edits and after the swap read
`Boots a pylon on <b>tower</b> from image <code>img-0000000000aa</code> and starts an empty repository on <code>dev</code>.`
The swap kept the worker, title, node, branch and project, and the Nexus agent's fields stayed shown. On the branch
the server sent an empty hint, so the client wrote all three hints. `branch/start-after-swap.png` shows the dialog
after the swap.

Each `?streaming=1` poll of the harness thread's page:

| | main | branch |
| --- | --- | --- |
| `data-shows` | absent | the view's name, a new one after the output grew |
| conversation region | 11,245 to 11,254 bytes, which the client discards | empty |

On both, the page kept the stream's render: 81 message rows and the call's output `compiling\nlinking\n`.

`liveFrames`, in ms per frame (`main/bench.txt`, `branch/bench.txt`):

| view | main median | branch median | main p90 | branch p90 |
| --- | --- | --- | --- | --- |
| harness | 4.59 to 4.79 | 1.39 to 1.57 | 5.7 to 6.4 | 2.4 to 2.7 |
| Claude | 4.59 to 4.61 | 1.39 to 1.60 | 5.4 to 5.5 | 2.0 to 2.1 |

The first frame of a harness view takes 18 to 20 ms on both commits, and of a Claude view 6 to 7 ms on main and under
4 ms on the branch. A harness view's first frame on the branch also digests its 400 entries once for the view's
name. A CPU profile of the branch's frames puts about a quarter of what is left in `imagePaths`,
which scans each message's text for image paths on every frame. The rest goes to the tool rows, which are rendered
whole every frame, and to assembling and scanning the region.
