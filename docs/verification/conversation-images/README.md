# Images in the conversation verification

Verified in this thread's pylon on 2026-10-29, on branch `feat/conversation-images` against main at `e15c1cb`, with Node 26.12.1 and headless Chromium from `@sparticuz/chromium`. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/conversation-images/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`, what the driver measured in `findings.txt` and each conversation's text in `<thread>.txt`. Both runs use the same two files, so the captures differ only by the code under test. `RUNS=main` or `RUNS=branch` runs one of them.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` runs the real registry, API and dashboard on 127.0.0.1:7470 with three threads:

- `worker`, a Claude worker whose transcript is a file in Claude Code's record shapes. The person pastes a screenshot, Claude runs a command that saves two, reads one back with Read, and names both in its reply, along with one under `/tmp`. The record of the Read holds the image's base64 twice, as Claude Code writes it, so it is about 740 KB. The checkout's own transcript reader reads the file over the stand-in probe's pipe, as it reads a pylon's.
- `harness`, a harness conversation whose person sends a screenshot, whose `read` call returns one, and whose reply names a file.
- `paused`, a Claude worker on the same transcript, whose pylon pauses after its first read. Port 7489 lets the driver run it again and pause it again.

Every thread's checkout is one fixture repository in which `docs/shots/conversation-phone.png` changed and `docs/shots/conversation-desktop.png` was added since the pylon booted. The screenshots are the dashboard captures of [the scrolling fix](../dashboard-scrolling/README.md). Only what a pylon cannot host is a stand-in: whois answers the laptop, the model is the test harness, the probe runs the guest's commands here against the fixtures, and the node's observation is written by the stack.

`drive.mjs` opens each thread at 1280×900 and at 390×844 as a phone. It opens every fold and call, captures the whole conversation as one tall image (`-all`), counts the images, whether each loaded and fits its column, and the `[image]` placeholders. On `worker` it clicks the first image and captures the tab that opens (`-full-size`), then opens both screenshots' diffs from Changes (`-diff-`). Then it opens `paused`, lets its pylon run while the page stays open, as after the wake a visit asks for, and captures it again (`-after-run`). Last, it asks the image route directly for what it must serve and refuse.

## What was checked

| Check, at both widths | main, e15c1cb | this branch |
|---|---|---|
| `worker`, the person's pasted screenshot | The text `[image]` | The screenshot, linked to its full size |
| `worker`, Claude's Read of a screenshot | "No output.", then "Claude Code wrote a oversized record", since the record is over 512 KiB | The screenshot in the call's body, which starts open |
| `worker`, two checkout files the reply names | Their paths as text | Both screenshots, each captioned with its path. `/tmp/before.png` is not shown |
| `harness`, a sent screenshot and a `read` result | `[image/png image]` twice | Both screenshots, and the file the reply names |
| Images that load, and are wider than their column | none | 4 of 4 and 3 of 3 load, none wider. No page scrolls sideways |
| A click on an image | nothing to click | A new tab with the image at its full size, 390×544 |
| `paused`, its pylon paused | `[image]` and the oversized notice | Each image is a note that it can't be shown while the pylon is paused. No image load asked to wake it: the stack logged 16 wake requests on each run, all from page visits and Changes reads |
| `paused`, its page left open while the pylon runs again | Unchanged | The notes give way to the 4 images within a poll. On the phone pass, the two transcript images had loaded already, from the browser's cache of the desktop pass |
| The diff of a changed screenshot | "The file is binary, so there is no diff to show." | Before and After side by side |
| The diff of an added screenshot | The same | "Before: none, the file is new", and After |

What the route served and refused, asked directly (`findings.txt`):

| Asked | Answer |
|---|---|
| A transcript image the page shows | 200 `image/png`, `private, max-age=31536000, immutable` |
| The same, with its SHA-256 changed | 404, the image is gone |
| The same image of the paused thread | 409, the pylon is not running and the request does not wake it |
| A checkout file the page shows | 200 `image/png`, `no-cache` |
| `/tmp/before.png` | 400, outside the checkout |
| `../../../etc/passwd` | 400, outside the checkout |
| `style.css` | 415, not a PNG, JPEG, GIF or WebP image |
| The changed screenshot at the pylon's start | 200, the earlier bytes |
| The added screenshot at the pylon's start | 404, it does not exist at that base |

## Not verified here

- A real pylon, a real Claude Code session's transcript and pi-durable. The transcript is written in the record shapes Claude Code 2.1.308 wrote in this thread's own session for a Read of a PNG, and read by the real reader through a stand-in pipe. The harness conversation is the test fake.
- A pasted image as Claude Code records it. The paste is modelled as an `image` item beside the prompt's text, which is how the API carries it. No paste was recorded here.
- A real phone, dark mode, and images over 1.4 MB, whose Read record passes the 4 MiB limit and is skipped as before.
- Images in a prompt Claude took from its queue mid-turn, which still read `[image]`.
