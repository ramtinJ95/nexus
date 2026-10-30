# Checkout parse verification (issues #220, #221, #223, #224)

Verified in this task's pylon on 2026-10-30, on branch `simplify/w5-checkout-parse`, against main at `ccc2f2e`. No live control plane, node, image or other thread was touched. Nothing here needs Docker, tailscale or root.

## What runs

`run.sh` checks out main and this branch's last commit that changes code into two worktrees, and runs the same two things in each.

- `capture.ts` drives the real code of the checkout under test and prints what the agent, the control plane and a person can see of it. A `git` first on PATH logs every git command the code runs, and the agent's git config sets `diff.renames=false`, `diff.noprefix=true` and `color.diff=always`. It covers:
  - `addOutput`'s declared diff of one tree that holds a plain edit, a rename with an edit, a binary edit, an untracked file, an ignored file and an ignored file the agent force-added. It prints the record, the diff file, whether `git apply` takes the file at the record's base, and which files then match the checkout;
  - the Changes read of the same tree through `checkoutReader`, with the git commands it runs;
  - the refusals that name a base kind, and the declared diff's refusals: a clean tree, no commits and no files, a checkout that is not a git repository, and no checkout;
  - the error text of malformed git facts and agent usage replies;
  - `parseLeaveOut` for each kind, for an unknown kind and for an inherited name, and the settled leave-outs.
- The five test files that hold the pins. The branch's test files run in both trees, so main's run shows which new tests fail there.

## Captures

`main.txt` and `branch.txt` come from `capture.ts`, and `capture.diff` is their diff. Each changed line is a change the branch makes on purpose:

- The declared diff runs checkout-files.py's `diff-to`. The scratch index is a copy of the agent's index followed by `git add --all`, not `git read-tree` of HEAD followed by `git add -A`, so unchanged files keep their stat data and git does not hash them again. The diff runs with `--find-renames` and `--no-relative`.
- With the agent's `diff.renames=false`, main's declared diff showed the rename as a delete and an add. The branch shows `rename from src/old.ts` and `rename to src/new.ts`, as the Changes view does, and `git apply` takes it at the base. With git's default config, main's diff also showed renames.
- The force-added ignored `kept.log` is in the branch's declared diff and comes back with `git apply`. Main left it out, though its Changes view listed it. `dist/bundle.js`, which is ignored and not added, is in neither.
- The Changes read runs one `git diff -z --raw --numstat` in place of `--name-status` and then `--numstat`. Its files, statuses and counts are the same in both.
- A declared diff in a checkout that is not a git repository, or where there is no checkout, is an `OutputRefused` with the helper's text. Main failed with git's or the shell's exit code.
- Malformed git facts and agent usage replies fail with one line that names the read and each wrong field, not with a bare `SyntaxError` or a `ZodError` dump.

The refusal texts that name a base kind, the declared diff's other refusals, the Changes files and every `--leave-out` result are the same in both.

`tests-main.txt` and `tests-branch.txt` hold the pinned test files' results. On main, 4 of 100 fail:

- `a diff output shows a rename as a rename, whatever the agent's config, and applies to its base`
- `a diff output holds an ignored file the agent force-added, as the Changes view does`
- `a diff of a checkout that is not a git repository is refused`
- `a reply that is not git facts fails naming the read`

All 100 pass on the branch. The new Changes, agent-setup and artifacts tests pass on main too. They pin behavior the refactor keeps.

## How to rerun

```sh
docs/verification/checkout-parse/run.sh [main-commit] [branch-commit]
```
