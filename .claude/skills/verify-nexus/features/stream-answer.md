# Stream an answer

The agent's answer shows up while it is written. `nexus watch --json` prints it as `live` events several times a second, and the thread page grows it in place. A reader who scrolled up keeps their place while it grows, and a hidden tab lets go of its stream until it is shown again.

## Sub-features

- `stream-cli` prints the answer as `live` events several times a second, then its `entry` before the `live` that drops the partial.
- `stream-ui` grows the answer in place on the thread page and keeps the composer's draft.
- `stream-hold` keeps a reader who scrolled up where they are while the answer grows, and keeps a reader at the end at the end.
- `stream-hidden` closes the page's stream while the tab is hidden, and opens a new one when it is shown.

## How to get to it (user POV)

- Run `nexus watch <thread> --json`, as the Claude mod and the pi extension do, then send a message.
- Open the thread page, `/threads/<id>`, send a message, and read the answer as it grows. Scroll up, or switch to another tab and back.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Thread `T` was started with `$V cli stream-start -- start --project spoon --title "stream: proof" --json`, and `$V cli stream-pre-show -- show $T --json` reads `.pylon.actualState` `running`.
- `E=$($V evidence)`.

- **Watch.** Before the send, start the watch in the background and stamp each line with the time it arrived:
  `node src/cli/nexus.ts watch $T --json --url http://127.0.0.1:7470 --socks none | perl -MTime::HiRes=time -ne 'BEGIN{$|=1} printf "%.3f %s", time, $_' > "$E/stream-watch.jsonl" &`.
- **Send.** Run `$V browser stream-ui-open -- goto http://127.0.0.1:7470/threads/$T`, then `$V browser stream-ui-fill -- fill "#prompt-text" "stream: 2500"` and `$V browser stream-ui-send -- click "#send"`. The answer takes 50 s. Two seconds later type a draft with `$V browser stream-ui-draft -- fill "#prompt-text" "a draft typed while it streams"`.
- **Page stream open.** Four seconds after the send, run `$V browser stream-ui-open-check -- eval '() => (streaming() && frames > 0 ? "PASS" : "FAIL") + " readyState " + stream?.readyState + " after " + frames + " frames"'`. Stdout holds `PASS`.
- **Scroll hold.** Ten seconds after the send, scroll up:
  - Run `$V browser stream-hold-set -- eval '() => { const room = scroller.scrollHeight - scroller.clientHeight; if (room < 300) return "FAIL only " + room + "px to scroll"; scroller.scrollTop = room - 250; window.verifyHold = { top: scroller.scrollTop, height: scroller.scrollHeight }; return "PASS held at " + scroller.scrollTop + " of " + scroller.scrollHeight; }'`.
  - Four seconds later run `$V browser stream-hold-check -- eval '() => { const h = window.verifyHold; const grew = scroller.scrollHeight - h.height; return (Math.abs(scroller.scrollTop - h.top) < 1 && grew > 0 ? "PASS" : "FAIL") + " scrollTop " + h.top + " became " + scroller.scrollTop + " while the page grew " + grew + "px"; }'`, and `$V browser stream-hold-shot -- screenshot --filename stream-hold.png`.
  - Run `$V browser stream-end-set -- eval '() => { scroller.scrollTop = scroller.scrollHeight; window.verifyEnd = scroller.scrollHeight; return "PASS at the end"; }'`, and three seconds later `$V browser stream-end-check -- eval '() => { const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight; return (scroller.scrollHeight > window.verifyEnd && gap < 48 ? "PASS" : "FAIL") + " " + gap + "px from the end, height " + window.verifyEnd + " became " + scroller.scrollHeight; }'`.
  - Each `eval` prints `PASS`.
- **Hidden tab.** While it still streams, hide the page:
  - Run `$V browser stream-hide -- eval '() => { window.verifyFirst = stream; Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); window.verifyFrames = frames; return (stream.readyState === EventSource.CLOSED ? "PASS" : "FAIL") + " readyState " + stream.readyState + " after " + frames + " frames"; }'`.
  - Six seconds later, more than one dashboard poll, run `$V browser stream-hidden-check -- eval '() => (stream === window.verifyFirst && stream.readyState === EventSource.CLOSED && frames === window.verifyFrames ? "PASS" : "FAIL") + (stream === window.verifyFirst ? " the same" : " another") + " stream, readyState " + stream.readyState + ", " + (frames - window.verifyFrames) + " frames while hidden"'`.
  - Run `$V browser stream-show -- eval '() => { delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); return stream !== window.verifyFirst ? "PASS opened a new stream" : "FAIL no new stream"; }'`, and two seconds later `$V browser stream-shown-check -- eval '() => (streaming() && frames > window.verifyFrames ? "PASS" : "FAIL") + " readyState " + stream.readyState + ", " + (frames - window.verifyFrames) + " frames since"'`.
  - Each `eval` prints `PASS`.
- **Grows in place.** Take `$V browser stream-ui-shot-<i> -- screenshot --filename stream-<i>.png` every 4 s for five shots. Each shows the answer longer than the one before, and the composer still holds the draft.
- **Done.** Once `$V cli stream-show -- show $T --json` reads `.thread.agentTurnRunning` `false`, take `$V browser stream-ui-done -- screenshot --filename stream-done.png` and `snapshot --filename stream-done.md`, then stop the watch with `kill %1`.
- **Live rate.** In `$E/stream-watch.jsonl`, the `live` events with a `partial` come at 3 or more a second, with no gap of 1 s or more, each `partial` a longer prefix of `word0 word1 ...`. The `pi.assistant` `entry` holds all 2500 words, and it comes before the `live` whose `partial` is `null`.
- **Proof.** `stream-watch.jsonl` with the rate and gaps worked out from it, every `eval` step's stdout, `stream-hold.png`, the five `stream-<i>.png`, `stream-done.png` and `stream-done.md`.

## Gotchas

- Start the watch before the send. A watch started later misses the first `live` events, and its rate covers only part of the answer.
- `watch` runs until it is stopped, so it runs outside `$V cli`, which records a command only when it exits.
- The `eval` steps read the dashboard script's top-level `stream`, `frames`, `streaming` and `scroller`. Renaming any of them in `src/control/dashboard/client.js` breaks these steps.
- Headless Chromium keeps every tab visible, so a second tab does not hide the first. The hidden step overrides `document.visibilityState` on the page and dispatches `visibilitychange`, and `delete document.visibilityState` restores it.
- The page's stream proves the browser let go of its stream. That the control plane then frees the stream's watch is covered by the API's tests, not by this recipe.
- Only a `stream: <n>` message streams. Its answer is `word0 word1 ...`, one word every 20 ms, so `stream: 2500` takes 50 s, long enough for every step above.
