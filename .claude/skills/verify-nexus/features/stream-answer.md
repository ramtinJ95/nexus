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

- **Watch.** Before the send, start the watch as a background command whose own shell stays alive until the watch ends, and stamp each line with the time it arrived. In an agent harness, run this as one background command, such as a Bash call run in the background, and keep its pid:
  `node src/cli/nexus.ts watch $T --json --url http://127.0.0.1:7470 --socks none | perl -MTime::HiRes=time -ne 'BEGIN{$|=1} printf "%.3f %s", time, $_' > "$E/stream-watch.jsonl" & wait`.
  The file soon holds a `reset`, a `state` and a `live` with `partial` null.
- **Open and hook the page.** Run `$V browser stream-ui-open -- goto http://127.0.0.1:7470/threads/$T`. Then hook the page's streams so later steps can see them: `$V browser stream-hook -- eval '() => { const B = window.EventSource; window.verifyStreams = []; window.EventSource = class extends B { constructor(...a) { super(...a); this.frames = 0; this.addEventListener("message", () => { this.frames += 1; }); window.verifyStreams.push(this); } }; Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); return verifyStreams.length === 1 ? "PASS hooked" : "FAIL " + verifyStreams.length; }'`. Stdout holds `PASS hooked`. The quick hide and show makes the page replace the stream it opened on load with one made through the hook, so `verifyStreams` holds the page's own streams, newest last.
- **Send.** Run `$V browser stream-ui-fill -- fill "#prompt-text" "stream: 4000"` and `$V browser stream-ui-send -- click "#send"`. The answer takes 80 s. Two seconds later type a draft with `$V browser stream-ui-draft -- fill "#prompt-text" "a draft typed while it streams"`.
- **Page stream open.** Four seconds after the send, run `$V browser stream-ui-open-check -- eval '() => { const s = verifyStreams.at(-1); return (s.readyState === 1 && s.frames > 1 && document.querySelector("#convo [data-grow]") ? "PASS" : "FAIL") + " readyState " + s.readyState + " after " + s.frames + " frames"; }'`. Stdout holds `PASS`. The growing slot proves the stream carries the answer, not only the page's first frame.
- **Scroll hold.** Ten seconds after the send, scroll up:
  - Run `$V browser stream-hold-set -- eval '() => { const scroller = document.getElementById("scroll"); const room = scroller.scrollHeight - scroller.clientHeight; if (room < 300) return "FAIL only " + room + "px to scroll"; scroller.scrollTop = room - 250; window.verifyHold = { top: scroller.scrollTop, height: scroller.scrollHeight }; return "PASS held at " + scroller.scrollTop + " of " + scroller.scrollHeight; }'`.
  - Four seconds later run `$V browser stream-hold-check -- eval '() => { const scroller = document.getElementById("scroll"); const h = window.verifyHold; const grew = scroller.scrollHeight - h.height; return (Math.abs(scroller.scrollTop - h.top) < 1 && grew > 0 ? "PASS" : "FAIL") + " scrollTop " + h.top + " became " + scroller.scrollTop + " while the page grew " + grew + "px"; }'`, and `$V browser stream-hold-shot -- screenshot --filename stream-hold.png`.
  - Run `$V browser stream-end-set -- eval '() => { const scroller = document.getElementById("scroll"); scroller.scrollTop = scroller.scrollHeight; window.verifyEnd = scroller.scrollHeight; return "PASS at the end"; }'`, and three seconds later `$V browser stream-end-check -- eval '() => { const scroller = document.getElementById("scroll"); const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight; return (scroller.scrollHeight > window.verifyEnd && gap < 48 ? "PASS" : "FAIL") + " " + gap + "px from the end, height " + window.verifyEnd + " became " + scroller.scrollHeight; }'`.
  - Each `eval` prints `PASS`.
- **Hidden tab.** While it still streams, hide the page:
  - Run `$V browser stream-hide -- eval '() => { window.verifyFirst = verifyStreams.at(-1); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); window.verifyFrames = verifyFirst.frames; window.verifyStreamCount = verifyStreams.length; return (verifyFirst.readyState === 2 ? "PASS" : "FAIL") + " readyState " + verifyFirst.readyState + " after " + verifyFirst.frames + " frames"; }'`.
  - Six seconds later, more than one dashboard poll, run `$V browser stream-hidden-check -- eval '() => (verifyStreams.at(-1) === verifyFirst && verifyStreams.length === verifyStreamCount && verifyFirst.readyState === 2 && verifyFirst.frames === verifyFrames ? "PASS" : "FAIL") + " streams " + verifyStreams.length + " readyState " + verifyFirst.readyState + ", " + (verifyFirst.frames - verifyFrames) + " frames while hidden"'`.
  - Run `$V browser stream-show -- eval '() => { delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); return verifyStreams.at(-1) !== verifyFirst ? "PASS opened a new stream" : "FAIL no new stream"; }'`, and two seconds later `$V browser stream-shown-check -- eval '() => { const s = verifyStreams.at(-1); return (s !== verifyFirst && s.readyState === 1 && s.frames > 0 ? "PASS" : "FAIL") + " readyState " + s.readyState + ", " + s.frames + " new stream frames"; }'`.
  - Each `eval` prints `PASS`.
- **Grows in place.** Take `$V browser stream-ui-shot-<i> -- screenshot --filename stream-<i>.png` every 4 s for five shots. Each shows the answer longer than the one before, and the composer still holds the draft.
- **Done.** Once `$V cli stream-show -- show $T --json` reads `.thread.agentTurnRunning` `false`, take `$V browser stream-ui-done -- screenshot --filename stream-done.png` and `$V browser stream-ui-done-snap -- snapshot --filename stream-done.md`. The answer ends in `word3999` and the composer still holds the draft. Then stop the watch's background command by killing its process group.
- **Live rate.** In `$E/stream-watch.jsonl`, the `live` events with a `partial` come at 3 or more a second, with no gap of 1 s or more, each `partial` a longer prefix of `word0 word1 ...`. The `pi.assistant` `entry` holds all 4000 words, and it comes before the `live` whose `partial` is `null`.
- **Proof.** `stream-watch.jsonl` with the rate and gaps worked out from it, every `eval` step's stdout, `stream-hold.png`, the five `stream-<i>.png`, `stream-done.png` and `stream-done.md`.

## Gotchas

- Start the watch before the send. A watch started later misses the first `live` events, and its rate covers only part of the answer.
- `watch` ends on a deleted thread, a closed pipe, or when its parent process exits, which it checks after each poll. A watch left behind with a trailing `&` by a shell that then returns has lost its parent: one ran 30 s and stopped before the answer ended. Keep its shell alive with `& wait` in a background command.
- The watch runs outside `$V cli`. `$V cli` writes stdout to its file as the command runs, but echoes it and writes `.exit` only when the command ends, and the file has no timestamps.
- The dashboard's script is a minified ES module, so its variables are out of a page `eval`'s reach. The `eval` steps see the page's streams only through the `stream-hook` step's `EventSource` wrapper, and read the conversation's scroller as `#scroll`. A page loaded again, by `goto` or a reload, needs the hook again.
- Headless Chromium keeps every tab visible, so a second tab does not hide the first. The hidden step overrides `document.visibilityState` on the page and dispatches `visibilitychange`, and `delete document.visibilityState` restores it.
- The page's stream proves the browser let go of its stream. That the control plane then frees the stream's watch is covered by the API's tests, not by this recipe.
- Don't open a diff tab during the recipe. An open tab hides `#scroll` and the composer, so the scroll and draft steps fail.
- Keep the watch's own background command as its only reader. A driver that reads the watch's pipe between browser commands stamps lines late and shows gaps that are not in the stream.
- Only a `stream: <n>` message streams. Its answer is `word0 word1 ...`, one word every 20 ms, so `stream: 4000` takes 80 s, long enough for every step above. `stream: 2500` ended before the last two of the five shots.
