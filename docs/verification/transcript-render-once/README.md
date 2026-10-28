# Claude transcripts render once per change verification

Verified in this task's pylon on 2026-10-28, on branch `perf/transcript-render-once`, against main at 637e93f, with
Node v24.22.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/transcript-render-once/run.sh origin/main <branch-commit>
```

`run.sh` checks out both commits into two worktrees, builds the dashboard assets in each, copies `measure.ts` into
each and runs it there, so the two runs differ only by the code under test. Each run's output lands in `main/` or
`branch/`, with the commit in `commit.txt`. `compare.ts` prints the table below into `compare.txt` and exits non-zero
if the two clients saw different things, or if the branch's client could certify a reply it had not shown.

`measure.ts` starts the real API with the real registry on a SQLite file, the real dashboard and the real Claude
transcript reader. The fake pylon is a probe whose streams run the reader's command on a local transcript file, as
the API tests do. The transcript starts with the fixture's prompt and tool calls and 600 replies, about 630 entries.
A turn runs, and a client holds the thread page's stream open. The script then steps 120 seconds of mocked timers.
That covers 60 working reads, 8 pings and 24 page polls, with 2 new replies every 10 seconds.

At 119 s a turn ends with a reply. The script holds the read that brings the reply, and a poll comes while it is
held, after the stream showed the turn's end. Then the next turn starts. At 120 s the last turn ends. Each poll is the
request client.js makes while its stream is open, `GET /threads/<id>?streaming=1`, on both checkouts. Main ignores
the query.

The script counts these:

- The rows of `SELECT entry FROM claude_entries` for a view, by patching `StatementSync.all`. The usage-limit check's
  reads of the newest 16 entries are counted apart, because this change leaves them alone.
- The calls of `convo()` and `blockView()` in `dashboard.ts`, from V8's precise coverage, split by whether a poll or
  the stream asked.
- The stream's events and bytes as its client reads them, and the poll responses.

## Work done

`compare.txt`:

| Work | main | branch | change |
|---|---:|---:|---:|
| Entries parsed for the stream's views | 37857 | 25 | -99.9% |
| Entries parsed for the page polls' views | 15514 | 0 | -100% |
| Whole-conversation renders for the stream | 84 | 14 | -83% |
| Whole-conversation renders for the page polls | 25 | 0 | -100% |
| Blocks rendered to HTML, stream | 51577 | 8630 | -83% |
| Blocks rendered to HTML, page polls | 15339 | 0 | -100% |
| Stream frames sent | 15 | 14 | -7% |
| Stream frames that changed only an age | 2 | 0 | -100% |
| Stream frames that only name the view shown | 0 | 1 | new |
| Stream bytes sent | 2404403 | 2085229 | -13% |
| Page poll bytes sent | 4331909 | 435228 | -90% |
| Bare pings | 6 | 8 | 33% |
| Transcript reads from the pylon | 63 | 63 | 0% |
| Usage-limit check entries (not this path) | 1392 | 1392 | 0% |

Every branch number matches the script. The 25 entries are the 24 new steps and the one reply, each parsed once. A
poll reads no entry, because nothing was added since the stream's last view. On main, every working read and every
poll reads all of the entries again, about 620 each. The branch's 14 renders are its 14 frames, 13 that changed the
conversation and one that names the view when the turn at 119 s ended. Main renders the whole conversation on every
read and every ping. Main's 2 frames that changed only an age came from the pings at 45 s and 90 s. Those are the two
points where "started just now" becomes "started 1 min ago" and then "started 2 min ago". On the branch those are
bare pings, and the client ticks the age.

On the branch, the number of changes limits the work. Each frame still renders the whole conversation, about 615
blocks, because a frame compares the whole region. Each changed view also hashes its entries once to name the view.
The pylon reads are unchanged, because a running turn needs them.

Two runs of `run.sh` gave byte-identical output directories, because the timers are mocked and the script waits for
each read to land before it steps on. Three mutants made `run.sh` exit 1:

- A view that drops the entries after the kept ones.
- A reader that tells no watcher about a read that appended entries.
- A page that sends a Claude worker's reply watermark before a read that started after the reply is stored. Its
  client certified the 119 s reply before showing it.

## Nothing a person or client sees changed

`compare.txt` also checks what the client saw:

- The conversation states the client showed, in order, are identical, 16 on both. Ages are compared by their instant,
  as the client ticks them.
- The conversation the client showed last is identical.
- Each poll's page outside the conversation is identical, with the thread ID, asset hashes and ages normalized.
- The watermark each poll let the client certify is identical, except at 119 s. There, main's client certified the
  turn's reply before it showed it, because its stream's region matched the poll's render, and neither had the reply.
  The branch's poll sent no watermark, because the stored transcript's last read that reached its end started before
  the reply was recorded. At 120 s,
  after the frame with the reply, both certified the newest watermark. Main has this gap today. The branch closes it,
  which is the one change a person can notice. A Claude worker's seen marker no longer moves for a reply the page has not shown.

`tests-branch.txt` is the typecheck and the full suite on the branch. It lists the new tests and the one existing
test that changed:

- A watched thread's view holds what the registry stores as real reads append, drop entries past the most kept,
  replace the transcript with one that ends as the old one did, and change session. `tests-main.txt` runs it against
  main's code, where it passes, so it pins behaviour main had. With the kept view not dropped on a replacing read, it
  fails.
- A poll of a Claude worker's streaming page renders no conversation and names the view of the stream's last frame.
  After a read brings a reply, the poll names another view until the frame that shows the reply arrives.
- With the read after a turn's end held, the stream shows the turn's end and the poll names that view, but sends no
  watermark. Once the read lands and its frame shows the reply, the poll sends the reply's watermark. Without the
  check of the read's start, it fails.
- With a transcript too long for one read, and the second read after a turn's end held, the poll sends no watermark
  while the stored transcript stops short of the reply. With every read dated by its start, it fails.
- A Claude worker's page stream names the same view for the same entries in another array, and another view for a
  transcript that ends as the old one did. A view whose region reads as before gets a frame of its name alone.
- A page stream sends nothing during four pings over a minute, though the age in its conversation changed. The first
  frame after them is the read's. With the bare ping removed, it fails.
- The age the client ticks equals the age a render of the page at the same instant shows, across the thresholds of
  45 seconds, 45 minutes and 36 hours.
- The existing page stream test now accepts a frame that only names the view, which comes when a turn starts.

## Not verified

- Wall time. The table counts operations, not milliseconds.
- A browser. `client.js` was not run. The script applies its rule for certifying a watermark, and the tests pin the
  server's half of it. The age tick is checked against `ago.js`, the module the client imports.
- A harness thread's poll still renders its conversation while it streams. Only a Claude worker's poll skips it. The
  bare ping and the client's ages apply to both.
- The CLI's `claudeFrames` still tells a replaced transcript by its last entry, as on main.
- Two replies recorded in the same millisecond put the second one millisecond ahead of the clock. A read that starts in
  that millisecond counts as before the reply, so the page sends no watermark until the next read. The thread then
  stays unread until the next session event, though the person sees the reply.
- The usage-limit check that reads the newest 16 entries on each thread row is unchanged.
