# Highlighted diffs verification

Verified in this task's pylon on 2026-10-26, on branch `pierre-diffs`, with headless
Chromium. No live control plane, node, image or other thread was touched.

## The stack

`stack.ts` runs the real registry, API and dashboard on `127.0.0.1:7470` with one running
thread. Its checkout is a fixture repository the stack makes, with a TypeScript edit, a
deleted Go file, a pure rename, a mode change, a binary file, a 25,000-line CSV, a Python
edit since a latest-turn snapshot and an uncommitted CSS file. The probe is a fake whose
raw pipe runs the real checkout helper on this machine against that repository, so the
Changes view and each diff come from real git output.

`drive.mjs` opens the thread page in headless Chromium (`@sparticuz/chromium` and
`puppeteer-core`, installed outside the repo), opens each file's diff on each base, light
and dark, unified and split where the page offers both, and writes `<label>.log`. It fails
on any CSP violation or page error. The `before-*` captures are this drive on `main`'s
dashboard code, and the `after-*` captures are the branch.

## What was checked

- `after-modified-ts.png`, `after-dark-modified-ts.png`. The TypeScript edit is
  highlighted, with the changed words marked inside each changed line, in both themes. The
  diff sits on the dashboard's own background and font. Before, the same diff was plain
  monospace (`before-modified-ts.png`).
- `after-split-ts.png`, `after-dark-split-ts.png`. Split puts the old file beside the new.
  Switching layout redraws the open diff without reading the pylon again.
- `after-turn-python.png`, `after-head-css.png`. Latest turn and Only uncommitted show
  their own diffs, highlighted as Python and CSS.
- `after-deleted.png`, `after-renamed.png`, `after-mode.png`, `after-binary.png`. A deletion
  shows its removed lines. A pure rename and a mode change list their git lines and say "No
  lines changed." A binary file says there is no diff to show. These notes read as before.
- `after-long.png`. The 25,000-line CSV shows its first 20,000 rows and the cut-short note
  below them, as before. It drew 1.4 s after the click on a cold page, including the
  grammar's fetch.
- `after.log`. No CSP violation and no page error, under the page's unchanged policy. The
  page loaded `client.js` and one small shared chunk before any diff opened. The library and
  each grammar came later, only for the languages opened: TypeScript, Go, CSV, Python and
  CSS.

## Not verified

- A real pylon, probe and node. The checkout reads went through a fake probe.
- A deploy. The release build's `install_release` was run as root into a sandbox prefix
  in this pylon, not on a node, and `nexus deploy` was not run.
- Safari and Firefox, and the phone layout beyond a check that the diff scrolls on its own
  at phone width.
