# Dashboard themes verification

Verified in this thread's pylon on 2026-10-29, on branch `feat/dashboard-themes` against main at `0c6e230`, with Node 26.12.1 and headless Chromium from `@sparticuz/chromium`. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<folder of a fonts.conf listing its fonts> \
  docs/verification/dashboard-themes/run.sh [commit]
```

`run.sh` checks the commit out into a worktree, the branch's head by default, copies `stack.ts` and `drive.mjs` into it, builds the dashboard, starts the stack and drives it. The captures land in `captures/`, with the commit in `commit.txt`. The fonts `@sparticuz/chromium` ships have no monospace face, so this run's `fonts.conf` also named DejaVu Sans Mono from the npm package `dejavu-fonts-ttf`. Neither has a ⌘ glyph, so the shortcut hints show a box.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` is [the dashboard-scrolling stack](../dashboard-scrolling/README.md) with only its paths changed: the real registry, API and dashboard on 127.0.0.1:7470, with 52 threads, a harness conversation of 40 rounds with tool calls and code blocks, a Claude worker's transcript, three questions on one thread, a review under way, an approved review with its land card, a checkout with a diff across 40 files, pipeline items and a node's health.

No pylon runs, so the terminal tab's WebSocket is a stand-in in the page. It attaches at once and sends a fixed screen: a prompt, a reply shaped like Claude Code's with a removed and an added line, and the 16 colours of the palette, normal and bright. xterm.js, `term-view.js` and the page's CSS are the real ones, so the colours come from the theme as they would with a real pylon.

## What was captured

`captures/<theme>/` holds, for Light, Dark, Tokyo Night, Catppuccin Mocha and Kanagawa Wave:

- At 1280×900 (`desktop-*`) and 390×844 as a phone (`phone-*`): the home page, the long conversation, the question cards, the diff of `src/control/loop.ts`, the terminal tab and the pipeline page.
- At the desktop width only: the Claude worker's transcript, the review, the land card, the usage page, the node page and a toast.
- On the phone only: the sidebar drawer with the picker.

`findings.txt` holds each check of the picker's behaviour, with what the page measured and `ok` or `BUG`:

- `first paint with client.js served empty, stored light: data-theme light, background rgb(255, 255, 255), the picker untouched at system -> ok`
- `first paint with client.js served empty, stored dark: data-theme dark, background rgb(28, 28, 30), the picker untouched at system -> ok`
- `first paint with client.js served empty, stored tokyo-night: data-theme tokyo-night, background rgb(26, 27, 38), the picker untouched at system -> ok`
- `first paint with client.js served empty, stored catppuccin-mocha: data-theme catppuccin-mocha, background rgb(30, 30, 46), the picker untouched at system -> ok`
- `first paint with client.js served empty, stored kanagawa-wave: data-theme kanagawa-wave, background rgb(31, 31, 40), the picker untouched at system -> ok`
- `nothing stored, a light device: picker system, data-theme light -> ok`
- `System, the device turns dark with the page open: data-theme dark, background rgb(28, 28, 30) -> ok`
- `System, the device turns light again: data-theme light -> ok`
- `picking Tokyo Night: data-theme tokyo-night, background rgb(26, 27, 38), same document true, stored tokyo-night -> ok`
- `Tokyo Night after a reload: data-theme tokyo-night, picker tokyo-night -> ok`
- `the toggle from Tokyo Night: labelled "Switch to the light theme", then data-theme light, picker light, labelled "Switch to a dark theme" -> ok`
- `the toggle again: data-theme tokyo-night, picker tokyo-night -> ok`
- `the toggle from Light before any dark theme was picked: data-theme dark -> ok`
- `the toggle from System on a dark device: data-theme light, picker light -> ok`
- `another tab when this one picks Kanagawa Wave: data-theme kanagawa-wave, picker kanagawa-wave -> ok`
- `the open diff when Light becomes Catppuccin Mocha: code background lab(93.7649 7.77516 4.64429), then lab(18.8417 8.25015 -9.10847), same document true -> ok`
- `the open terminal through Light, Tokyo Night and Kanagawa Wave: background rgb(22, 24, 29), rgb(26, 27, 38), rgb(31, 31, 40); red rgb(204, 0, 0), rgb(247, 118, 142), rgb(195, 64, 67) -> ok`
- `storage that refuses writes: pick Tokyo Night, toggle, toggle: data-theme tokyo-night, light, tokyo-night -> ok`
- `a toast in light: shown true -> ok`
- `a toast in dark: shown true -> ok`
- `a toast in tokyo-night: shown true -> ok`
- `a toast in catppuccin-mocha: shown true -> ok`
- `a toast in kanagawa-wave: shown true -> ok`

## Contrast

`src/control/dashboard/style.test.ts` computes WCAG contrast for every theme. It asks 4.5:1 of body text and the second text level on every surface they lie on, of a button's text on the accent, of a diff line's text on its tint and of the terminal's text. It asks 3:1 of the dim level and the status colours on the page. The pairs below a bar are listed in the test, so a new miss fails it:

| Theme | text on page | text on card | second level on card | dim on sidebar | button text | removed line | added line | error on page | terminal text |
|---|---|---|---|---|---|---|---|---|---|
| light | 16.83 | 16.26 | 6.14 | 3.09 | 4.71 | 5.31 | 4.81 | 4.33 | 14.07 |
| dark | 14.43 | 12.14 | 6.48 | 3.44 | 6.66 | 7.89 | 8.67 | 5.42 | 14.07 |
| tokyo-night | 8.10 | 6.90 | 5.15 | 2.55 | 6.79 | 5.10 | 6.81 | 6.46 | 8.10 |
| catppuccin-mocha | 11.34 | 8.69 | 7.70 | 6.49 | 8.07 | 5.43 | 7.62 | 7.08 | 11.34 |
| kanagawa-wave | 11.26 | 8.93 | 6.49 | 2.97 | 11.26 | 2.84 | 3.90 | 3.22 | 11.26 |

The misses are macarchy's own colours, kept as macarchy has them: Tokyo Night's `muted_text` on the page and the sidebar, and Kanagawa Wave's `muted_text` on the sidebar, and its `success` and `error` on the diff's tints. Body text meets AA in every theme.

## Not verified here

- Safari, Firefox and a real phone. Chromium's mobile emulation stands in for a phone.
- A real pylon's terminal. The screen is a fixed stand-in, as above.
- The native `<select>` popup, which headless Chromium does not draw in a screenshot. The driver picks with the element itself.
- Storage that refuses reads. Then client.js stops at its first read, before the picker loads, as it does on main. `theme.test.js` covers the picker's store in that case.
- The flash on load is checked by refusing `client.js`, so only the head script runs, and reading the theme the page painted. A slow device's first frame was not filmed.
