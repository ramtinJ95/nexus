# Dashboard polling verification

Verified in this task's pylon on 2026-10-28, on branch `perf/dashboard-polling` with the code of abe07e1, against main
at 3ce3164. The runs used Node v24.22.1 and headless Chromium 153. No live control plane, node, image or other thread
was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/dashboard-polling/run.sh origin/main <branch-commit>
```

`run.sh` checks out both commits into two worktrees, builds the dashboard in each, copies `measure.ts` into each and
runs it there, so the two runs differ only by the code under test. Each run's output lands in `main/` or `branch/`.
`compare.ts` prints the tables below into `compare.txt`. It exits 1 if the tabs of the two runs showed different
notifications, toasts or titles, or if the branch's page marked seen again a reply another client marked unseen.

`measure.ts` starts the real registry on a SQLite file, the real API and the real dashboard, with the fake model
harness the API tests use. Two projects hold 44 threads: 10 open, 4 archived and 30 deleted. Four tabs of one headless
Chromium open the dashboard, the hidden ones first:

- a hidden home page,
- a hidden thread page,
- a visible, focused thread page, whose conversation streams,
- a visible home page without focus, like a second window.

Whether a tab is shown and focused is set in the page, as `document.visibilityState` and `document.hasFocus()`, because
headless Chromium shows every tab. So the hidden tabs run at full speed. A real browser throttles a hidden tab's timers,
which delays main's hidden-tab poll and not the branch's event stream. This run does not measure that.
`Notification` is replaced by a recorder that reports permission as granted. The page also records when each tab's
wait for a change ended: when it sent a list read, and when the event stream's message came.

The script runs three measured phases:

1. An idle minute. Nothing changes.
2. Sixteen attention rounds. Each one starts after a fixed jitter, the same on both runs, so a change does not land at
   the same point of every poll or stream tick. Even rounds record a reply on one thread and mark it seen 6 s later.
   Odd rounds report a Claude session waiting for input and then a turn starting. Each tab's title is read 5 s into
   the round.
3. A takeover. The first tab closes, and two more rounds run. On the branch that tab followed the events.

Then the agent of the focused page's thread replies three times. The script times how long the page takes to mark
each reply seen. Last, another client marks the reply unseen, and the script waits 8 s to see whether the page marks it
seen again.

The script counts work during the idle minute and during the sixteen rounds:

- Every SQL statement the registry runs, by patching `StatementSync`, as reads or writes.
- The calls of `row()`, `detail()` and `followEvents()` in `api.ts`, of `markSeen()`, `eventBatch()` and
  `withSessions()` in `registry.ts`, and of `sidebar()`, `home()` and `threadPage()` in `dashboard.ts`. The counts
  come from V8's precise coverage.
- Every request each tab sent, from Chromium.

## Work done

`compare.txt`:

| Work in the idle minute | main | branch | change |
|---|---:|---:|---:|
| `GET /v1/threads`, all four tabs | 240 | 6 | -97% |
| Requests from the two hidden tabs | 120 | 6 | -95% |
| Thread rows built, `row()` | 10560 | 1140 | -89% |
| Thread details built, `detail()` | 1596 | 12 | -99% |
| Session reads per thread, `withSessions()` | 12204 | 1872 | -85% |
| SQL statements read | 162720 | 17592 | -89% |
| `POST /v1/threads/<id>/seen` | 18 | 0 | -100% |
| `markSeen()` write transactions | 18 | 0 | -100% |
| SQL statements written | 18 | 0 | -100% |
| Event batches read, `eventBatch()` | 60 | 120 | 100% |
| Page renders, `sidebar()` | 24 | 24 | 0% |

| Work in the sixteen attention rounds | main | branch | change |
|---|---:|---:|---:|
| `GET /v1/threads`, all four tabs | 544 | 78 | -86% |
| Requests from the two hidden tabs | 272 | 78 | -71% |
| Thread rows built, `row()` | 23936 | 3556 | -85% |
| Thread details built, `detail()` | 3591 | 28 | -99% |
| Session reads per thread, `withSessions()` | 27714 | 7264 | -74% |
| SQL statements read | 369162 | 60212 | -84% |
| `POST /v1/threads/<id>/seen` | 40 | 0 | -100% |
| `markSeen()` write transactions | 48 | 8 | -83% |
| SQL statements written | 376 | 336 | -11% |
| Event batches read, `eventBatch()` | 136 | 272 | 100% |
| Page renders, `sidebar()` | 54 | 56 | 4% |

The idle numbers follow from the code:

- On main, each of the four tabs reads the list every second: 4 × 60 = 240 reads. Each read builds a row for all
  44 threads: 240 × 44 = 10560 rows.
- On the branch, only the hidden home page reads the list, because it holds the lock. With nothing changing, it reads
  only its 10 s safety read: 6 reads. Each one builds a row for the 14 threads that are not deleted, which is 84 rows.
  The 24 sidebars build a row for each of the 44 threads they list, which is 1056 rows. The home tables reuse the
  sidebar's rows. That is 1140 rows in all.
- On main, each sidebar and each home table built the detail of every thread: 24 × 44 + 12 × 44, plus one for each
  of the 12 thread pages, which is 1596. On the branch only the 12 thread pages build a detail.
- On main, the focused page posted `/seen` 18 times, once every 3 to 4 s, and each post ran a write transaction.
  The branch posts no `/seen`, because the reply the page shows did not change.
- Main's 60 event batches come from the Claude conversation loop, which follows session events once a second on both
  checkouts. The branch adds 60: the leading tab's event stream reads one batch a second. Each batch is three indexed
  SELECTs, which the SQL read count includes.
- The visible tabs refresh their pages every 5 s on both checkouts, so the page renders do not change.

In the rounds, all 78 list reads are the hidden home page's. It reads after each batch of row events, when a
held-back reply comes due, and every 10 s. No row had a turn running over an unread reply, so its 1 s read never ran.
No other tab read the list. The 8 `markSeen()` calls on the branch are the
script's own: it marks each round's reply seen. The 40 written statements main has over the branch are its 40 `/seen`
posts. The two extra sidebar renders are the visible tabs' 5 s refresh, whose phase differs between the runs.

The numbers do not cover:

- What a real browser does to a hidden tab's timers.
- More than one browser. Each browser has its own leading tab and its own stream.
- A page over plain HTTP. It has no Web Locks, so it keeps main's 1 s read in every tab.
- Time per request. These are counts of operations, not milliseconds.

The control plane serves at most 16 streams, and the branch holds one more for each browser. Over the run the branch
opened two: the hidden home page's at load, and the hidden thread page's when it took the lock after the home page
closed. Neither measured phase saw a stream open. That a second tab opens none while the first holds the lock is the
unit test's check, not this run's. Main opens no stream for the list.

## Nothing a person or client sees changed

`compare.txt` also checks what each tab showed:

- Same notifications and toasts, on the same tabs, for the same rounds: yes, 70 on main and 70 on the branch. The
  focused thread page showed a toast. The other three tabs showed a system notification, the visible home page among
  them, because it has no focus.
- Same tab titles 5 s into every round: yes, `(1) Nexus` on every tab in every round.
- After the tab that followed the events closed, the remaining three tabs still notified in both takeover rounds.

The delay from the registry's change to each notification, in ms:

| Delay | main mean | branch mean | main max | branch max |
|---|---:|---:|---:|---:|
| New reply, hidden tabs | 2562 | 2487 | 3803 | 2892 |
| New reply, all tabs | 2758 | 2492 | 4002 | 2892 |
| Waiting for input, hidden tabs | 625 | 663 | 912 | 873 |
| Waiting for input, all tabs | 619 | 664 | 984 | 874 |

A reply is held back 2 s in case work resumes. On main, a tab notifies at its first poll after the 2 s, up to a
second later. On the branch, the leading tab reads the list when the 2 s are up, so a reply notified within 2.9 s.

A change that notifies at once waits on a one-second cadence on both checkouts: each tab's poll on main, and the event
stream's tick on the branch. The worst case was 984 ms on main and 874 ms on the branch. The branch's mean was higher
in each of the six runs made while writing this, four of them of earlier versions of the branch or main, by 45 to 111 ms. The split below shows why:

| A waiting session's notifications, mean ms | main | branch |
|---|---:|---:|
| From the change to what ended the wait | 611 | 659 |
| From that to the notification | 9 | 5 |

What ends the wait is main's list read and the branch's stream message, or its 10 s read when that came first, as
it did once. After it, the branch is as fast as main.
The whole difference is in the wait, which is the phase of a 1 s timer when the change lands. Each round starts at a
fixed time, so each run's timers fall at fixed and different points of it. On main the four tabs poll at four phases,
and on the branch every tab waits on the one tick. A uniform phase averages 500 ms. The mean of 9 samples varies by
about 100 ms around that.

Seen marks:

- A new reply on the focused page was marked seen after 6282, 2194 and 6592 ms on main, and after 3316, 4181 and
  4611 ms on the branch. The page certifies a reply with its 5 s refresh on both checkouts. Then main posts at its
  next 1 s poll that is 3 s past the last post, and the branch posts within a second.
- A reply another client marked unseen while the page showed it: main marked it seen again after 1993 ms. On the
  branch it stayed unseen for the 8 s, with attention `reply`. This is the intended change.

The typecheck and the full suite pass on the branch, 1337 tests of 1337, in `tests-branch.txt`. The unit tests pin
both behaviours on the real client code, run in a `vm` context by `src/control/dashboard/notifications.test.js`:

- "a hidden tab notifies from the rows the tab that follows the events read, with no request of its own".
- "the tab that follows the events reads every second while a turn runs over an unread reply, as its stop sends no
  event".
- "the tab that follows the events reads again a second after a read failed".
- "a page marks each reply it shows seen once, so one marked unseen elsewhere stays unseen".

Each failed when one of these was removed: the `marked` update, the BroadcastChannel post, the timer for a
held-back reply, the asking of the leading tab, the 1 s read while a turn runs over an unread reply, or the retry after
a failed read.

## Found on main and left alone

While writing this script, a harness thread page stopped certifying its reply. The client ticks the "started 1 min
ago" text of the conversation since #162. The comparison of a poll with the stream's last frame strips only the run
clocks, not those ages. So once a page's age text crosses a minute after the stream's last frame, the page certifies
no reply until the next frame. The script starts its focused thread three hours back so that its age holds still.
This change does not touch that comparison.
