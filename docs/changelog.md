# Changelog

What each version of the API contract and the Mac `nexus` CLI changed, newest first. The top entry is the version in [`src/version.ts`](../src/version.ts), which `nexus --version` prints and the control plane reports. The CLI refuses a control plane older than `minControlVersion` in [`src/cli/config.ts`](../src/cli/config.ts), except in the commands [Version skew](cli.md#version-skew) names, so an entry says what an older control plane does only while that floor is below it, and raising the floor deletes those notes. [`src/docs.test.ts`](../src/docs.test.ts) checks both.

## 0.84.0

A pylon's sessions are Herdr Core terminals, so a session's `herdrPane` is a Core terminal address such as `t7`, the attach route's `pane` matches `^t[0-9a-z]{1,12}$` and attaches to that terminal alone, and `ThreadDetail.attach` is `hc`. A failed session in no terminal keeps the address it was recorded at as its `id`, in place of a `failed-` hash. Removes `POST /v1/threads/<thread>/sessions/<session>/focus`, which a control plane older than 0.84.0 still serves: the dashboard's Show in terminal attaches its terminal tab to the session instead. The CLI never called it. The probe reads and opens only Core terminals, so a pylon on an image without Herdr Core lists no sessions, keeps its last sessions file through a pause, and fails to open or relaunch a session. On an image with Herdr Core, a wake relaunches each session the sessions file records in a new terminal, one recorded under Herdr included.

## 0.83.0

Adds `nexus exec <thread> <line>`, which runs a shell line in a running pylon with stdin and stdout piped to it untouched, as `ssh` does, from the WebSocket `GET /v1/threads/<thread>/exec`, so `hc machine add --via 'nexus exec <thread>'` makes the pylon a Herdr Core machine, as [the exec route](cli.md#the-exec-route) describes. It never wakes a pylon. A control plane older than 0.83.0 answers the route 404, so `exec` fails there.

## 0.82.0

Adds `nexus cat <thread> <path>`, which writes one file of the pylon's checkout to stdout as its bytes, from `GET /v1/threads/<thread>/files/content`, and takes no `--json`. Adds `images`, `node show <name>` and `thread show <thread>`, which run `image list`, `node <name>` and `show <thread>`. `archive`, `unarchive`, `delete` and `seen` take several threads, as [Commands](cli.md#commands) describes: one prints as before, and several print one line each, or with `--json` one array of `{"given", "reply"}` or `{"given", "error", "kind", "status", "code"}`. No route changes, so a control plane older than 0.82.0 serves all of them.

## 0.81.0

Adds `nexus answer <question|thread> [option]`, which prints a question and its options, or a thread's open questions, and with an option answers it through `POST /v1/questions/<id>/answer` once the person types `yes` in a terminal, as [Answering from the CLI](cli.md#answering-from-the-cli) describes. Without a terminal it refuses before it sends anything. Adds `GET /v1/questions/<id>`, which answers the `Question` as stored. A control plane older than 0.81.0 answers that route 404, so `answer` there finds a question only by its thread.

## 0.80.0

`deploy`, `release`, `doctor` and `connect` run against a control plane older than `minControlVersion`, and warn a terminal, so a `git pull` that raised the floor leaves the commands that upgrade it working. A control plane newer than the CLI gets a terminal one line that says to pull the checkout and run `deploy/mac/install` again. `connect` and `doctor` print both versions, and `connect --json` adds `versions`. The config file honours `XDG_CONFIG_HOME`, and keeps a file already at `~/.config/nexus/cli.json`, as [Connecting a device](cli.md#connecting-a-device) describes. No route changes.

## 0.79.0

Adds `fetches` to `ImagesView`, which `GET /v1/images` and `image list --json` answer: one `ImageFetch` per online node that lacks the current image, which the control plane copies it to outside a rollout, as [Images](cli.md#images) describes. Plain `image list` prints them under the images. A control plane older than 0.79.0 omits the field, and `image list` prints no fetches. A rollout step a node skips now says the control plane sends it the image once it is back online. `nexus doctor` gains an `image` check per node.

## 0.78.0

Adds `templateInputs` to `Project`, a list of repository paths whose git object IDs at the thread's commit join the template key beside `.nexus/setup`'s, as [Templates at thread start](cli.md#templates-at-thread-start) describes. `project edit --template-input PATH` sets it, and `--clear-template-inputs` empties it. `PATCH /v1/projects/<id>` and `POST /v1/projects` accept it. A project that lists none keeps the template keys it had. A control plane older than 0.78.0 answers an edit that sets it with 400, so `project edit --template-input` fails there with exit code 64.

## 0.77.0

Adds `status=open` to `GET /v1/threads`, which lists only active and idle threads, and answers 400 to any other `status`. The dashboard reads it for its notifications. `threads --open` asks for it, and prints only the active and idle threads. A control plane older than 0.77.0 ignores `status` and answers every thread but the deleted ones, so `--open` leaves out the archived ones itself. Every other query answers as before.

## 0.76.0

`POST /v1/threads/<thread>/review` answers once the review is recorded, and the loop starts its reviewer threads after, so `Review` gains `reviewerStarted`, false until then, and `reviewer` names a thread that appears once it starts. A refused reviewer start holds the review for the person instead of refusing the request. `Review` gains `earlierRounds`, the rounds the PR's earlier reviews spent: a later review of a PR gets what they left of the 5, `review` fails with exit code 5 once none are left unless `--rounds N` grants more, and `ReviewView.round` and `maxRounds` count the PR's reviews, so `maxRounds` may be above 5. A review of a PR that another builder's unsettled review holds fails with exit code 5. `POST /v1/threads` answers 409 to a request ID whose thread is archived or deleted, or whose queued start was cancelled. The CLI says a change whose answer timed out after it went out may have gone through.

## 0.75.0

Adds `ThreadDetail.noChange`: why the builder found that its task needs no change, as it declared in a `nexus-no-change` block instead of opening a pull request, or null. `show` prints it as an `outcome:` line, and prints none for an older control plane, which omits the field. A queued thread's `Wait` on such a builder reads `landed`, with `why` set to `needs no change: <the reason>`.

## 0.74.0

Removes `review`, the stored review record, from `ThreadDetail`, so `GET /v1/threads/<thread>` and `show --json` no longer send the reviewer's token, the loop's asks or its outbox. `reviewView` carries the review's public facts in its place: `pr`, the pull request's number, `phase`, its kind and while it is `needs-person` its `reasons`, `round` and `maxRounds`, `reviewer`, the reviewer thread and its model, and `landsWhenApproved`, as [Reviews and landing](cli.md#reviews-and-landing) describes. `said.review`, and the `said` of the review routes, now also hold a failed live check's last 20 lines of output, what the review needs from the person and its waiver, which the CLI printed from the record. `land --waive` that answered the review's question prints `reviewView` with `--json`, in place of the record. The review routes still answer with the record. The CLI now needs a control plane of 0.74.0 or later.

## 0.73.0

Adds the sentences the CLI prints of a thread and its review to the replies, worded once by the control plane. `ThreadDetail` gains `said`: what a guest that stopped answering fails and what gives it a fresh VM, why an archived thread's disk is kept, why its token usage is unread, how a paused session resumes, the PR watch's state, and the review's line and notes. The `Review` that `POST /v1/threads/<thread>/review`, `/review/cancel` and `/land` answer gains `said`, the review's line and notes. Every other field is as before.

## 0.72.0

Adds `Question.kind`, which names what a question is about and how it is answered: `proposal`, `ask`, `holds`, `judgment` or `cleanup`, as [Questions](cli.md#questions) describes. `reserved` is still on every question, and null on every kind but `holds`. Every other field is as before.

## 0.71.0

Adds what the clients worked out from the stored records to the replies. `ThreadDetail` gains `reviewView`, the merge policy's answer for the thread's review: its holds, what a Land press does, and the review's open question about its holds. It also gains `keptPastDay`, why an archived thread's disk is kept past its 24 hours. `ReleaseView` gains `controlNode`, the node the control plane runs on. Each frame of `GET /v1/threads/<thread>/events` gains `busy`, whether the agent's run is working and how many messages wait for it, on the first frame and whenever it changed. `review` and every other field are as before.

## 0.70.0

Adds `status=queued` to `GET /v1/queued`, which leaves out cancelled and deleted queued threads, and `cancelled=false` to `GET /v1/items`, which leaves out cancelled items. `threads` and `items` ask for them rather than filtering the reply, unless `--all` is given.

## 0.69.0

Adds the code `queued` to the 409 a thread route answers for a thread that has not started, and makes the clients branch on `code` and `retryable` rather than on the status: `show` reads `GET /v1/queued/<thread>` only after a 409 with code `queued`, and the CLI's and the dashboard's waits for a running pylon try again only a refusal whose `retryable` is true, so they now also wait through `draining`, and the dashboard no longer waits out a 409 that no wait fixes, such as `blocked`. `events --follow`, `watch` and `attach` reconnect on one schedule: 1 second, then twice as long each time, up to 30 seconds, and `watch` up to its interval.

## 0.68.0

Adds `retryable` to the API's error body, and sets `code` on every error reply, null where the API sends no code, so the body is `{"error": string, "code": string | null, "retryable": boolean}`, as [Failures](cli.md#failures) describes. It also adds the codes `draining`, `probe-unreachable` and `probe-forbidden`.

## 0.67.0

Adds yolo landing: `project edit --auto-review yolo`, and `--auto-review` on `project add`, under which the review loop answers each review's holds question with Land for the deployer who turned it on, as [Yolo landing](merge-policy.md#yolo-landing) describes. `Project.autoReview` is now `{ mode, enabledBy }`, `mode` being `review`, `land` or `yolo`, and `PATCH /v1/projects/<id>` takes `autoReview: { mode }`, and still `{ land }`. `Waiver.yolo` names the project whose setting gave a waiver, which `show` prints and the `review.waived` event carries.

## 0.66.0

Adds a second reviewer on another model: `project edit --second-reviewer off|on|always|reserved,lines=N`, `Project.secondReview` and `secondReview` in `PATCH /v1/projects/<id>`, `Review.second`, `Round.secondVerdict`, the hold `no-second-reviewer`, `second` in the `review.changed` event, and the line `show` prints of both reviewers' verdicts, as [Reviews and landing](cli.md#reviews-and-landing) and [Project editing](cli.md#project-editing) describe.

## 0.65.0

Adds `Question.holds`, the question a review asks about the holds at its head that the person may waive, as soon as Nexus knows them, and makes `land --waive` answer it with `Land`, through `POST /v1/questions/<id>/answer`, while the review still runs too, as [Questions](cli.md#questions) and [Reviews and landing](cli.md#reviews-and-landing) describe.

## 0.64.0

Adds `Thread.turnDied`, `ThreadDetail.resume`, the `thread.resumed` event, the `decision` attention for a Claude worker whose turns Nexus stopped resuming, and the `turn died:` and `resume:` lines of `show`, as [Turns that died](cli.md#turns-that-died) describes.

## 0.63.0

Adds a project's standing rules, Markdown the person sets once that each builder thread the project starts gets with its first message: `Project.standingRules`, `standingRules` in `POST /v1/projects` and `PATCH /v1/projects/<id>`, `Thread.standingRulesRevision` and the `standing rules:` line of `show`, `project show`, `project add --rules-file`, and `project edit --rules-file` and `--clear-rules`, as [Standing rules](cli.md#standing-rules) describes.

## 0.62.0

Makes `start --branch` refuse a branch the project's remote does not have, with exit code 64, the error code `no-branch` and nothing booted, as [the start notes](cli.md#commands) describe, and holds such a queued thread for the person, as [When it starts](cli.md#when-it-starts) describes. It also adds `Question.failure` and `Question.withdrawn`, and makes archiving a thread withdraw its open failure question and drop its `failed` attention, as [Failure judgments](cli.md#failure-judgments) describes.

## 0.61.0

Adds `land --waive`, which reads the thread's review, shows the person the holds the merge policy reserves for them at its head, and once they type `yes` in a terminal lands it past them, as the dashboard's Land press does, as [Reviews and landing](cli.md#reviews-and-landing) describes. It changes no route, and `land` without it sends `{}` as before.

## 0.60.0

Adds `ThreadDetail.pylon.notAnswering`, `{ since, timeouts }`, set while the pylon's node reports that at least 3 guest commands in a row got no answer from its guest, and the `guest:` line `show` prints for it, as [Node diagnostics](cli.md#node-diagnostics) describes.

## 0.59.0

Adds the review phase `quoting`, in which a landing at a head with no live check has the reviewer quote, from the description as it is then, what could not be checked live, and the round's `quotedFrom`. An approval that stops for the person now has the `decision` attention, and `POST /v1/threads/<thread>/land` answers 409 for a review held by what no press gets past, such as a Claude reviewer's approval. The CLI prints the new phase by name and changes no command.

## 0.58.0

Lowers the memory `project add` gives a project without `--memory` from 6 to 4 GiB, so a new project's pylons get 2 CPUs and 4 GiB, and so does the dashboard's new-project dialog. It changes no route, and a project already added keeps its size.

## 0.57.0

Replaces the daily reports with health alerts: it drops `GET /v1/reports` and `GET /v1/reports/<id|latest>`, and adds `GET /v1/checks`, `GET /v1/checks/changes`, `POST /v1/checks/seen`, `HealthView`, `HealthChange` and the `health.changed` event, as [Doctor](cli.md#doctor) describes. The CLI calls none of them.

## 0.56.0

Adds `GET /v1/nodes/<name>/metrics` and `NodeMetrics`, a node's health as the control plane recorded it, once a minute and each time something else read it, for the dashboard's Cluster page to graph, as [Node diagnostics](cli.md#node-diagnostics) describes. The CLI does not call it.

## 0.55.0

Makes `attach` reconnect when its link drops or the control plane stops, such as for a deploy, rather than exit, as [the commands](cli.md#commands) describe. It also adds `doctor`, as [Doctor](cli.md#doctor) describes.

## 0.54.0

Adds the filesystems Nexus writes to on a node: `disks` in `NodeSummary.capacity` and in `NodeHealth`, the `disk low at` that plain `nodes` prints for a low one, and a `disk:` line per filesystem from `node`, as [Placement](cli.md#placement) and [Node diagnostics](cli.md#node-diagnostics) describe. It also makes a start on a node it or its project names fail with exit code 5 when the node's pylons' filesystem would keep too little free.

## 0.53.0

Adds `version` to `GET /v1/health`, the version of this contract the control plane runs, and makes the CLI refuse a control plane older than 0.53.0, the oldest it reads, before it sends any other request: every command that calls the API, `connect` among them, reads health first, and fails with exit code 1 and a message that says to upgrade the control plane when its version is missing or lower, so the CLI no longer works around a control plane older than a field or route it reads.

## 0.52.0

Makes `item add` refuse an `--after` that names no item, such as `--after ,`, with exit code 64 and nothing sent, as `start` already refused one, where it sent `"after": []` before, as [Pipeline items](cli.md#pipeline-items) describes. It also makes `preview --wait` ride through a restart of the control plane, as `deploy --wait` and the image waits do, as [the preview notes](cli.md#commands) describe.

## 0.51.0

Adds `code` to the API's error body, `{"error": string, "code"?: string}`, and to the `--json` stderr line, as [Failures](cli.md#failures) describes, and makes `send` to a Claude worker that waits at a prompt in its terminal fail at once with exit code 5, rather than trying again for 120 seconds and saying its pylon did not run, as [Claude conversations and steering](cli.md#claude-conversations-and-steering) describes.

## 0.50.0

Adds the attach route's `pane`, the pane a terminal lands in, and `POST /v1/threads/<thread>/sessions/<pane>/focus`, which focuses a session's pane in Herdr, as [The attach route](cli.md#the-attach-route) describes. The dashboard uses both, and the CLI neither.

## 0.49.0

Makes `abort` interrupt a Claude worker's turn: the route presses Esc in the worker's Claude Code pane, as [Claude conversations and steering](cli.md#claude-conversations-and-steering) describes, and answers 409, which `abort` exits 5 for, when Claude is not working, waits at a dialog or runs in no pane.

## 0.48.0

Adds a review's model failures: `failing` on the review phases `reviewing` and `fixing`, `Review.asked`, and the note `show` prints while an agent's model fails, as [Reviews and landing](cli.md#reviews-and-landing) describes.

## 0.47.0

Adds `waiting` to a review's `merging` phase, which says why a landing that deploys has not merged yet, and the `waiting while` that ends `show`'s review line then, as [Reviews and landing](cli.md#reviews-and-landing) describes.

## 0.46.0

Lets `review --cancel` end a review that ended `needs-person`, so it stops setting the `decision` attention, as [Reviews and landing](cli.md#reviews-and-landing) describes.

## 0.45.0

Adds `review --cancel`, its route `POST /v1/threads/<thread>/review/cancel`, the review phase `{"kind": "cancelled", "who": "person", "by": string}` and what `show` prints of it, as [Reviews and landing](cli.md#reviews-and-landing) describes. It also makes every route that acts on a thread, its pylon or a project answer only a person: `abort`, `retry`, `retry-pylon`, `session open` and `session close`, `attach`, `preview` and `unpreview`, `review`, `project edit`, `archive`, `unarchive` and `delete`, which the control node, an infrastructure node or a pylon now gets 403 for, as [the commands](cli.md#commands) describe.

## 0.44.0

Adds a conversation's images: the `images` of a Claude worker's `prompt` and `result` entries, whose text no longer holds an `[image]` placeholder, the `[image]` line `conversation` prints for each image of a prompt, and the route `GET /v1/threads/<thread>/image`, which serves an image of the transcript, of a Nexus agent's conversation, or of the checkout, as [the route](cli.md#commands) and [Claude conversations and steering](cli.md#claude-conversations-and-steering) describe.

## 0.43.0

Makes `show` print `attach: nexus attach <thread>` for a thread that is not archived or deleted, so the command that attaches a terminal is there to copy, and makes `attach` land in a Claude worker's Claude Code pane, as [the commands](cli.md#commands) describe.

## 0.42.0

Makes a Claude worker's AskUserQuestion call a question while its dialog waits: `Question.ask`, `ClaudeAsk`, `AskedQuestion` and `Choice`, an answer's `choices`, the body `{"choices": [...]}` that answers such a question through `POST /v1/questions/<id>/answer`, the route's new 409s and 502 for one, and the lines `show` prints of one, as [A Claude worker's AskUserQuestion](cli.md#a-claude-workers-askuserquestion) describes.

## 0.41.0

Adds `connect`, which finds the control plane on a tailnet name, saves it in the config file and says what this device may do, its route `GET /v1/whoami` and `Whoami`, and `https://` control plane URLs. It drops the built-in URL and proxy: with no URL set, every command but `connect` fails with exit code 64 and says to run `nexus connect <host>`, and with no proxy set the CLI connects directly, as [Where it connects](cli.md#where-it-connects) describes. A Mac that relied on the old defaults runs `nexus connect rj-firebat.tailc817d3.ts.net --socks localhost:1055` once.

## 0.40.0

Adds planning threads: `start --plan`, `"planning": true` in `POST /v1/threads`, `ThreadDetail.planning` and the planning line of `show`, `Question.proposal`, and the answer to a proposal's question that adds a pipeline item, as [Planning threads](cli.md#planning-threads) describes.

## 0.39.0

Adds failure judgments: `ThreadDetail.judgments`, `JudgmentView` and the judgment lines of `show`, as [Failure judgments](cli.md#failure-judgments) describes.

## 0.38.0

Adds the live check: the review phase `verifying`, `Round.live`, the live check line of `show`, a verify pylon's thread started by `nexus-verify`, and `nestedVirtualization` in `ThreadDetail.pylon.resources`, as [Live checks](cli.md#live-checks) describes.

## 0.37.0

Adds pipeline items: `items`, `item add`, `item show`, `item approve` and `item cancel`, their routes under `/v1/items`, `PipelineItem` and `ItemPhase`, `project edit --pipeline`, `Project.pipeline` and its column in `projects`, as [Pipeline items](cli.md#pipeline-items) describes.

## 0.36.0

Adds `node <name>`, its route `GET /v1/nodes/<name>/health` and `NodeHealth`, ends a failed pylon's `failed` with the last lines of its controller log when its node reported it broken, prints those lines indented under the `failed:` line of `show`, and keeps only the first line of `failed` in a `watch` state line, as [Node diagnostics](cli.md#node-diagnostics) describes.

## 0.35.0

Adds questions a thread asks the person: `ThreadDetail.questions`, `Question`, the question lines of `show`, the `decision` attention for an open question, and the route `POST /v1/questions/<id>/answer`, as [Questions](cli.md#questions) describes.

## 0.34.0

Adds `start --request-id`, which makes a repeated start answer the thread the first one made, and sends `start --message` in the start's own request, as [Retry-safe starts](cli.md#retry-safe-starts) describes.

## 0.33.0

Adds `usage backfill`, its route `/v1/usage/backfill`, `UsageBackfill`, `BackfillThread` and `BackfillPlanRow`, `UsageReport.backfill`, the backfill line of `usage`, `Thread.readingUsage`, and the desired phase `reading`, as [Usage backfill](cli.md#usage-backfill) describes.

## 0.32.0

Adds `usage`, the tokens the agents of every thread spent, its route `GET /v1/usage` and `UsageReport`, as [Token usage](cli.md#token-usage) describes.

## 0.31.0

Drops the attach settings 0.9.0 retired: a config file with `"ssh"` or `"attach"` fails like one with any other unknown key, and `attach` no longer names them or `NEXUS_ATTACH` on stderr, as [attach](cli.md#how-attach-connects) describes.

## 0.30.0

Lands a review past the holds the person may waive when they press Land on the dashboard, which sends `{"head", "waive"}` to the land route, drops the field of `Review.waiver` that named the credential that confirmed it, with the dashboard's own routes and events of 0.28.0, and prints `waived by <node> at <commit>`, as [Reviews and landing](cli.md#reviews-and-landing) describes. `land` sends no `waive`, so it is unchanged. `show` from a CLI of 0.28.0 or 0.29.0 fails on a review the dashboard waived, since it reads the credential's name, so upgrade the CLI with the control plane.

## 0.29.0

Adds queued threads: `start --after`, which queues a thread to start once other threads' pull requests have merged, `start-queued`, `threads --queued`, what `threads`, `show`, `archive`, `unarchive` and `delete` print of a queued thread, `QueuedThread` and `Wait`, and the routes `GET /v1/queued`, `GET /v1/queued/<thread>` and `POST /v1/threads/<thread>/start`, as [Queued threads](cli.md#queued-threads) describes.

## 0.28.0

Added `Review.waiver`, the `waived by` lines of `show`, the event `review.waived`, and the routes the dashboard used to land a held review past the holds the person waived, as [Reviews and landing](cli.md#reviews-and-landing) describes.

## 0.27.0

Added `project edit --auto-review`, `Project.autoReview` and its column in `projects`, `Review.auto`, `Review.land.fromProject` and `Round.conflict`, has a landing's builder rebase a branch that conflicts with its base, and ends a held review whose pull request closed or whose builder was archived or deleted, as [Reviews and landing](cli.md#reviews-and-landing) and [Project editing](cli.md#project-editing) describe.

## 0.26.0

Adds the review phases `merged`, `closed` and `cancelled`, which end a review without asking the person, and what `show` prints of them, as [Reviews and landing](cli.md#reviews-and-landing) describes.

## 0.25.0

Lets a project's default node be `auto`, makes `project add` without `--node` add such a project, and added `NodeSummary.overcommitted`, `NodeSummary.pylons` and what plain `nodes` prints of them, as [Placement](cli.md#placement) describes. It also added `start --cpus`, `--memory` and `--disk`, `ThreadDetail.pylon.resources` and the size line of `show`, as [A thread's size](cli.md#a-threads-size) describes, and raised the memory `project add` gives a project without `--memory` from 4 to 6 GiB.

## 0.24.0

Caps a review at 5 rounds, gives a review whose rounds ran out the `needs human review` label and its `label`, shown by `show`, and replaces a finding's `severity` with `priority`, as [Reviews and landing](cli.md#reviews-and-landing) describes.

## 0.23.0

Added `Thread.setup` and the setup line of `show`, which say whether the pylon boots from a template or fresh, as [Templates at thread start](cli.md#templates-at-thread-start) describes.

## 0.22.0

Added `image build`, `image rollout`, `image rollback`, `image list` and `image current`, and their routes, as [Images](cli.md#images) describes.

## 0.21.0

Added the `limited` attention, `Thread.usageLimit`, `ClaudeConversation.usageLimit`, the `usageLimit` of a `notice` entry, the `usage-limit.continued` event, and the usage-limit lines of `threads`, `show` and `conversation`, as [Usage-limit stops](cli.md#usage-limit-stops) describes.

## 0.20.1

Made `send` to a Claude worker wait out the API's wait for the pylon, and a repeat of a send whose answer was lost report what it did, as [Claude conversations and steering](cli.md#claude-conversations-and-steering) describes.

## 0.20.0

Added `start --node auto`, `Thread.placement` and the placement line of `show`, and the CPUs and committed CPUs and disk of `NodeSummary.capacity`, as [Placement](cli.md#placement) describes.

## 0.19.0

Added `seen --last-reply-at`, made `watch` follow a Claude worker's transcript with `claude-reset` and `claude-entry` lines, and added the `pull-request` transcript entry. [The CLI page](cli.md#thread-fields) also lists every thread field since then, `sessionTurnRunning` among them, though the fields are older.

## 0.18.0

Added `review` and `land`, `ThreadDetail.review`, the `decision` attention and the `review.changed` event, as [Reviews and landing](cli.md#reviews-and-landing) describes.

## 0.17.0

Makes a Claude worker thread a conversation: `conversation` prints its Claude Code transcript and `send` types a message into its Claude session, as [Claude conversations and steering](cli.md#claude-conversations-and-steering) describes.

## 0.16.1

Added `--help` and `-h` after every command.

## 0.16.0

Added `start --claude --model`, defaulted Claude to Opus 5.5, disabled commit and PR attribution, and preserved busy launches across Herdr readiness timeouts. `show` reports the worker model and launch diagnostic.

## 0.15.1

Exposed stalled Claude worker launches, with pane diagnostics in `claudeWorker.message`.

## 0.15.0

Added the resumable event stream and Claude Code thread workers.

## 0.14.0

Added human-only project editing and a stale-grants warning.

## 0.13.0

Added `deploy`, `release`, and waiting for fleet release health.

## 0.12.0

Added PR-watch metadata and pull-request outputs to `show` (see [Pull requests](cli.md#pull-requests)).

## 0.11.0

Added Latest turn to dashboard Changes, `--turn` to `nexus changes` and `nexus diff`, and API `base=turn` with turn metadata and failures.

## 0.10.0

Added shared `seenAt`, `lastReplyAt` and `attention` to thread rows and detail, and `seen <thread> [--unread]`, so clients no longer need their own seen stores.

## 0.9.0

Made `attach` go through the control plane, over the attach route `GET /v1/threads/<thread>/attach`, a WebSocket, instead of ssh to the pylon's node, and retired its settings: `NEXUS_ATTACH`, and `"ssh"` and `"attach"` in the config file. In 0.9.0, `Preview.failed` and `ready` also cover a preview whose port has no route into the pylon, and `ports` prints why a preview is not ready.

## 0.8.0

Added `Session.id`, `Session.state` and `Session.message`, so a paused pylon lists the sessions its wake brings back and a session its last wake failed to bring back shows why, and `session close` now takes a session's ID, refuses a paused session, fails on a pane that is not open or that runs another session than the one listed there, and no longer tries again.

## 0.7.0

Added scratch projects, whose `Project.repoUrl` is null, `project add --scratch` and `--secret`, and a null `Base.commit` where the base is the empty tree.

## 0.6.0

Added `files`, `changes` and `diff`, their routes `GET /v1/threads/<thread>/files`, `GET /v1/threads/<thread>/changes` and `GET /v1/threads/<thread>/diff`, `Listing`, `Changes` and `Diff`, and the route `GET /v1/threads/<thread>/files/content`, which the CLI does not use.

## 0.5.0

Added `session open`, `session close` and `attach`, the routes `POST /v1/threads/<thread>/sessions` and `DELETE /v1/threads/<thread>/sessions/<pane>`, `OpenedSession`, `Session.title`, `Preview.failed`, and the attach settings: `NEXUS_ATTACH`, and `"ssh"` and `"attach"` in the config file.

## 0.4.0

Added `project add` and its route, `POST /v1/projects`.

## 0.3.0

Added `unpreview` and its route, `DELETE /v1/threads/<thread>/previews/<port>`.

## 0.2.0

Added `ports`, `preview`, `Preview.url`, `ThreadDetail.ports` and the `ports` of a watch `state`.
