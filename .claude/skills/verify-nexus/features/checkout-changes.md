# Checkout files, changes and diff

A user reads a thread's checkout without attaching to its pylon. The CLI lists a directory and lists or diffs what changed, either since the pylon booted, which includes the agent's commits, or since the last commit. The thread page's Changes tab shows the same changes as a folder tree, and each changed file opens as a diff tab beside the conversation.

## Sub-features

- `changes-files` lists the checkout or a directory in it, with each file's size, and refuses a missing path, a path outside the checkout and a file given as a directory.
- `changes-start` lists the files changed since the pylon booted, with their line counts.
- `changes-head` lists only the uncommitted changes, with `--uncommitted`.
- `changes-diff` prints the unified diff from either base, of the whole tree or of the paths given.
- `changes-read` serves a file's bytes from the API route that clients use. The CLI has no command for it.
- `changes-ui` shows the Changes tab's base line, its summary and its tree, and reads again by itself after an agent turn.
- `changes-tabs` opens a changed file as a diff tab, closes it, and returns to the conversation.
- `changes-ui-head` switches the tab to `Only uncommitted`.
- `changes-archived` refuses to read an archived thread's checkout.

## How to get to it (user POV)

- Run `nexus files <thread> [path]`, `nexus changes <thread> [--uncommitted]` and `nexus diff <thread> [path...] [--uncommitted]` in a terminal.
- `GET /v1/threads/<thread>/files/content?path=<path>` serves a file. The dashboard has no file view yet.
- Open the thread page, `/threads/<id>`, and choose the inspector's `Changes` tab. Choose a file in its tree to open its diff in a tab beside `Conversation`. Turn on `Only uncommitted` to compare with HEAD, and use ↻ to read again.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Thread `T` was started with `$V cli changes-start -- start --project spoon --title "changes: proof" --json`, and its pylon is `running`.
- After each `send` below, poll `conversation $T --json` until it ends in `scripted answer after toolResult`.

- **List.** `$V cli changes-files -- files $T --json` exits 0. `path` is `""`, `entries` include `{"name": ".git", "kind": "dir", "size": null}` and `{"name": "README.md", "kind": "file", "size": 15}`, and `truncated` is false.
- **List refusals.** `$V cli changes-files-missing -- files $T nope --json` exits 4 with stderr `{"error":"nope does not exist","kind":"not-found","status":404}`. `$V cli changes-files-outside -- files $T .. --json` exits 64 with `{"error":".. is outside the checkout","kind":"invalid","status":400}`. `$V cli changes-files-kind -- files $T README.md --json` exits 64 with `{"error":"README.md is not a directory","kind":"invalid","status":400}`.
- **Clean.** `$V pylon changes-base-ref $T -- git rev-parse refs/nexus/base HEAD` prints the same commit twice. Keep it as `B`. `$V cli changes-clean -- changes $T --json` has `base` `{"kind": "start", "commit": B}` and `files` `[]`. On the thread page's Changes tab, `#changes-base` reads `Since the pylon booted, <B's first 7>` and the body reads `Nothing has changed since the pylon booted.`
- **Commit, then leave work uncommitted.** Send `bash: printf 'one\ntwo\n' > notes.txt && git add notes.txt && git -c user.name=agent -c user.email=agent@invalid commit -qm notes`, then `bash: printf 'more\n' >> README.md && mkdir -p src && printf 'hi\n' > src/new.txt`. `$V pylon changes-refs $T -- git rev-parse refs/nexus/base HEAD` prints `B`, then a new commit `H`.
- **Since boot.** `$V cli changes-start-cli -- changes $T --json` lists `README.md` `modified` +1 −0, `notes.txt` `added` +2 −0 and `src/new.txt` `added` +1 −0, each with `oldPath` null.
- **Uncommitted.** `$V cli changes-head-cli -- changes $T --uncommitted --json` has `base` `{"kind": "head", "commit": H}` and lists only `README.md` and `src/new.txt`.
- **Diff.** `$V cli changes-diff -- diff $T --json` has a `.diff` with hunks for all three files. `$V cli changes-diff-path -- diff $T README.md --uncommitted --json` has only the `README.md` hunk, `+more`.
- **Read a file.** `$V cli changes-files-sub -- files $T src --json` lists `new.txt` with size 3. Then `curl -sS -D - "http://127.0.0.1:7470/v1/threads/$T/files/content?path=README.md" > "$($V evidence)/changes-read.txt"` holds a 200 with `content-type: text/plain; charset=utf-8` and the body `# verify-nexus` then `more`. `?path=src` answers 400 `src is not a file`, and `?path=nope` answers 404 `nope does not exist`.
- **Dashboard tree.** Open the thread page, select the Changes tab with `$V browser changes-ui-tab -- click 'label.seg-tab:has(input[value="changes"])'`, then `click "#changes-reload"`. `#changes-base` reads `Since the pylon booted, <B's first 7>`, the summary reads `3 files` `+4 −0`, and the tree holds `README.md` (M), `notes.txt` (A) and a `src` folder with `new.txt` (A). Capture `snapshot --filename changes-ui.md` and `screenshot --filename changes-ui.png`.
- **Diff tabs.** `click '.tree-file[data-path="README.md"]'` opens a `README.md` tab, and the diff's header reads `vs boot` with an added line `more`. `click '.tree-file[data-path="src/new.txt"]'` opens a second tab with an added line `hi`. Capture `snapshot --filename changes-tabs.md` and `screenshot --filename changes-tabs.png`. `click 'role=button[name="Close src/new.txt"]'` closes that tab only, and `click '[data-tab="convo"]'` shows the conversation again.
- **Only uncommitted.** `click 'role=checkbox[name="Only uncommitted"]'`. `#changes-base` reads `Since the last commit, <H's first 7>`, and the tree holds two files. Capture `changes-head-ui.md` and `changes-head-ui.png`, then click it again to turn it off.
- **Reads again after a turn.** Send `bash: printf 'x\n' > later.txt` from the composer (`#prompt-text`, then `#send`). Once the turn ends, the tree holds `later.txt` and the summary reads `4 files` `+5 −0`, with no reload.
- **Archived.** Archive `T` and poll `show` until `paused`. `$V cli changes-archived -- changes $T --json` exits 5 with stderr `{"error":"thread <T> is archived, so its pylon stays paused","kind":"conflict","status":409}`. On the page, without a reload, the tab reads `An archived thread's pylon stays paused, so its changes can't be read. Unarchive the thread to read them.` in place of the tree.
- **Proof.** The recorded `changes-files`, the three refusals, `changes-clean`, `changes-refs`, `changes-start-cli`, `changes-head-cli`, `changes-diff`, `changes-diff-path`, `changes-files-sub`, `changes-read.txt`, `changes-ui.md` with `changes-ui.png`, `changes-tabs.md` with `changes-tabs.png`, `changes-head-ui.md` with `changes-head-ui.png`, the snapshot that shows `later.txt`, and `changes-archived`.

## Gotchas

- A pylon-vm records `refs/nexus/base` on its first boot, and the Docker backend never does. The stack's image therefore carries the ref at its one commit. Without it, `changes` and `diff` without `--uncommitted`, and the Changes tab by default, fail with exit 1 and the API's 422, `the checkout has no refs/nexus/base ...`. That boot records the ref is proven only on a real node.
- The Docker checkout is always the image's one-commit repo. A scratch project's empty repository, whose base is the empty tree with a null `commit`, is not shown here.
- The inspector remembers its last tab across pages, in `localStorage`. Select the Changes tab before you assert on it, rather than relying on it being the default.
- An open diff tab hides the conversation and the composer. Return with `[data-tab="convo"]` before a step that types a message.
- `Only uncommitted` is remembered in `localStorage` too. Turn it off at the end, or later runs open on the last commit.
