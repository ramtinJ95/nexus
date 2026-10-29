# Diff panel rendering verification

Verified in this thread's pylon on 2026-10-29, on branch `fix/diff-panel-rendering` against main at `08b05d2`, with Node 26.12.1 and headless Chromium from `@sparticuz/chromium`. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<a fonts.conf dir> \
  docs/verification/diff-panel-rendering/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. The branch run's commit has the same `src/` as the branch's head. Both runs use the same two files, so the captures differ only by the code under test.

The fonts `@sparticuz/chromium` ships have no monospace face, CJK or emoji, so this run's `fonts.conf` also named DejaVu Sans Mono from the npm package `dejavu-fonts-ttf`, and Noto Sans SC and Noto Color Emoji from `@fontsource`, converted from WOFF to TTF.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` runs the real registry, API and dashboard on 127.0.0.1:7470 with one running thread. A stand-in probe runs the real checkout helper against a fixture repository whose working tree changes 98 files:

- `src/rules.ts`, 40 lines of about 330 characters, and `data/table.csv`, 40 columns wide with a change in column 38.
- `lib/new-name.js`, renamed with an edit, and `docs/renamed.md`, renamed without one.
- `assets/logo.png`, a changed binary file, and `assets/new-icon.png`, an added one.
- `src/added.ts`, added, and `src/gone.ts`, deleted.
- 80 files under `pkg/`, one changed line each.
- `src/generated.ts`, 30,000 lines, every one changed.
- `win/notes.txt`, CRLF with one line changed, and `win/endings.txt`, whose endings went from LF to CRLF.
- `Makefile` and `go/main.go`, indented with tabs.
- `i18n/greetings.md`, in several scripts, with emoji, combining marks, a zero-width space and a no-break space.
- `scripts/run.sh`, whose mode changed, `link-target.txt`, which became a symlink, and `config/no-eol.json`, which lost its last newline.
- A component nine folders deep with a 39-character name.

`drive.mjs` opens each file's diff from the Changes tree at 1280×900 and at 390×844 as a phone, screenshots it, and measures the checks below. It then writes a comment on a long line, on a CRLF line and on the very long file. It writes each result to `findings.txt`, with `BUG` or `ok`.

## The problems, and what the branch does

Screenshots are named `<width>-<step>-<case>.png` in `main/` and `branch/`.

| Problem on main, at both widths unless named | main, 08b05d2 | this branch |
|---|---|---|
| Long lines run off the panel, and the sideways scrollbar sits under the file's last row (`01`) | 2,072 px of text hidden to the side, the scrollbar 249 px below the panel on the desktop and 351 px on the phone | Lines wrap. Nothing is hidden. |
| A wide file's change is out of view (`19`) | The changed cell R6C37 is past the panel's edge, with nothing pointing to it | In view |
| A very long file freezes the page (`12`, `26`) | 6.0 s to draw on the desktop, with a 6.4 s long task. Writing a note on it takes 25.7 s, with an 11.4 s long task. | 1.0 s to draw, longest task 0.6 s. A note takes 3.9 s, longest task 0.5 s, most of it typing. |
| The very long file, whose first line changed, shows "1 unmodified line" above it (`12`) | The band shows | No band |
| The note that a diff is cut short sits under its last row (`12`) | Under 20,000 rows | Above the first of 2,000 rows |
| A change of line endings shows every line removed and added again, with nothing saying why (`20`) | Nothing says why | "line endings changed from LF to CRLF" above the lines |
| A deep path hides the file's name, and the base label wraps (`18`) | The name is cut off, and "vs boot" takes 2 lines | The folders give way first, and the name shows. A name too long for the header wraps. |
| Split on a phone (`21`) | About 20 characters a side | A window 760 px wide or less draws unified and hides the picker |
| Eight open files squeeze the tabs (`22`, `23`) | Every file tab's name is 0 px wide | Each name shows at least 41 px. The bar scrolls to the open tab, and the conversation's tab stays pinned at its start. A tab opened again from the left of the bar shows beside the pinned tab, not under it. |

These drew well on main and still do: renames with and without edits, binary files, added and deleted files, the mode change, the type change, the missing last newline, the CRLF file with one edit, tabs, which draw 2 columns wide, and unicode. Notes on a long line and on a CRLF line work on both, and a CRLF line's quote carries no CR.

## Not verified here

- A real phone, and Safari and Firefox. Chromium's mobile emulation stands in for a phone.
- The verify-nexus Docker stack, so no real pylon or agent. The diff comes from the real checkout helper run against a local fixture.
- Korean, Devanagari and Thai, which the fonts here lack, so they draw as boxes in both runs.
- Dark mode.
- The timings come from headless Chromium with software rendering in this pylon, so a laptop runs faster. They compare main and the branch on the same machine.

## Seen and left as they are

- A zero-width space draws as nothing, and the panel does not warn of invisible or bidirectional characters, as GitHub does.
- A rewrite longer than 2,000 rows shows only its first 2,000 removed lines, since the diff lists every removed line before the added ones.
- The panel shows a band for unchanged lines above a hunk, but none below the last hunk, because the diff does not say how long the file is.
