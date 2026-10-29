# No count on the browser tab

Verified in this thread's pylon on 2026-10-29, on branch `fix/no-tab-badge` against main at `1cebcf4`, with Node 26.12.1 and headless Chromium 153 from `@sparticuz/chromium`. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/no-tab-badge/run.sh origin/main HEAD
```

`run.sh` starts [`../dashboard-scrolling/stack.ts`](../dashboard-scrolling/README.md#the-stack) from a worktree of each commit: the real registry, API and dashboard, with 31 threads holding an unread reply and one waiting on a decision. `drive.mjs` opens the home page and a thread page, waits for the page's read of the thread list, and records the tab's title and icon link in `tab.json`.

## What was seen

| | main, 1cebcf4 | this branch |
|---|---|---|
| Title of the home page | `(9+) Nexus` | `Threads · Nexus`, as served |
| Title of a thread page | `(9+) Nexus` | `Split the reconcile loop into a planner and an applier · Nexus`, as served |
| Icon link once threads are read | a `data:` SVG of a red tile with `9+` | `/assets/favicon.svg?v=…`, as served |

`tab.png` in `main/` and `branch/` draws those values as tabs on a light and a dark tab bar. `icon.png` shows each commit's static icon at 16, 32 and 128 px on white and on `#202124`.

A headless browser has no tab bar, so the tab pictures are drawn from what the page set, not captured from Chrome, Safari or Firefox.
