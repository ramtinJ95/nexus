# Hold codes, end to end

Run on 2026-10-30 in this thread's pylon, at the commit in `commit.txt` (the branch before this capture was committed), with `run.sh`. No live control plane, node, image, GitHub repository or other thread was touched.

`stack.ts` is `land-button-waives/stack.ts`, the real registry, API, dashboard and review loop with GitHub, check threads and the release worker stood in, with one change: each seeded round records its live check as absent, as for a head with no `.nexus/verify`. That stack predates live checks, so without the change every landing it seeds also holds on "The live check has not run", on main as on this branch. `drive.mjs` replaces the browser with plain requests: it reads the API, fetches the thread page over HTTPS at the dashboard's address, and sends the land request the Land button sends, with the holds from the card's `data-holds`.

- `01-held-reserved.json`: PR #42's review is held for one reserved path, and `holds` pairs that reason with the code `reserved-path:irreversible`.
- `02-land-card.txt`: the Land card still marks it "you may waive", now through `holdRule(code)`, and `data-holds` still sends the text.
- `03-claude-refused.txt`: PR #45's holds are `claude-approved` and `reserved-path:auth`. A request that waives both is refused with 409, as before.
- `04-waived.txt` and `05-landed.txt`: waiving #42's hold by its text stores the waiver with `codes: ["reserved-path:irreversible"]`, the landing merges and deploys (`github.log`), and the `review.waived` event carries the codes beside the texts.

The record from before codes, a stored waiver of texts only, and a hold whose text changed are covered by `src/control/review.test.ts`, not here.
