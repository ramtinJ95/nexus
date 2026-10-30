# Dashboard shared formatters verification

Verified in this thread's pylon on 2026-10-30, on branch `simplify/w5-dashboard-shared` against main at `ccc2f2e`, with Node 26.12.1 and headless Chromium from `@sparticuz/chromium`. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=/tmp/al2023/lib AWS_EXECUTION_ENV=AWS_Lambda_nodejs22.x \
  docs/verification/dashboard-shared/run.sh origin/main HEAD
```

`AWS_EXECUTION_ENV` makes `@sparticuz/chromium` unpack the libraries its Chromium needs into `/tmp/al2023/lib`. `run.sh` checks out main and the branch into two worktrees, copies `drive.ts` into each, builds the dashboard and runs `drive.ts` there. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`, and the script prints the diff of the two `result.json` files.

## The stack

`drive.ts` starts the checkout's own registry, API and dashboard on a free port, with the test harness, a whois that names every caller as the person's laptop, and a probe whose terminal always fails to open. It starts one thread whose turn has run for 63 s. The browser's `Date.now` runs two hours ahead of the server, so each age and run clock the page ticks differs from what the server rendered. The driver then:

1. Reads the home page's ages and run clocks as served, and again after the client's tick.
2. Opens the start dialog, reads the model field's placeholder and hint, gives a Claude prompt whose first two lines are blank and whose first text line is 90 characters, and presses Start thread. The driver keeps the `POST /v1/threads` body and answers 400.
3. Opens the new-project dialog, reads its size hint, fills ID and URL and presses Add project. The driver keeps the `POST /v1/projects` body and answers 400.
4. Opens the thread page's terminal, and records the WebSocket URL, the text frames each way, and the status line.

## Main (`main/`) and this branch (`branch/`)

The two `result.json` files differ in one line, the model hint, which this branch renders from `defaultClaudeModel`:

```diff
<   "modelHint": "Opus 5.5 unless you name another.",
>   "modelHint": "claude-opus-5-5 unless you name another.",
```

Everything else matches on both:

- The served age `just now` ticks to `2 h ago`, and the served clock `1m 03s` ticks to `2h 01m`. On the branch, the client's tick is `elapsed.ts`, which the server also renders with.
- The start body's title is the prompt's first text line, cut to 80 characters with `...` after. On the branch it comes from `thread-title.ts`.
- The project body's resources are 2 CPUs, 6 GiB and 10 GiB, and the hint says the same. On the branch both come from `defaultProjectResources`.
- The terminal opens `ws://HOST/v1/threads/THREAD/attach?cols=60&rows=38&term=xterm-256color`, sends `{"type":"resize","cols":60,"rows":38}` once open, gets the route's `error` message and shows its text. On the branch, the URL's path is `attachPath` and the resize is `encodeMessage`, both from `attach-route.ts`.

## Not checked here

- An image of a changed file in the diff panel (`imageSides`), and an image the conversation names (`imagePaths`). The stack has no checkout or transcript with images. `diff.test.js`, `dashboard.test.ts` and `checkout-files.test.ts` check every extension of the table instead.
- A terminal attached to a real Herdr session. The probe here fails each open, so only the URL, the first resize and the error path ran.
