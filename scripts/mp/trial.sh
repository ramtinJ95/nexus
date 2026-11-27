#!/usr/bin/env bash
# Trial-merges pull request heads onto origin/multiplayer in a temporary worktree with its own node_modules, then runs
# the type check, the build, the tests and the landing model. With no head it measures the base, which gives this
# machine's own list of failing tests.
# usage: NEXUS_REPO=<your clone> scripts/mp/trial.sh <name> [<full head sha> ...]
# The worktree stays at <clone>/.claude/worktrees/<name> for scripts/mp/merge.sh, which removes it.
set -u
REPO=${NEXUS_REPO:?set NEXUS_REPO to your clone of the repository}
name=$1; shift
WT=$REPO/.claude/worktrees/$name
LOGS=${TMPDIR:-/tmp}/nexus-mp-trial
mkdir -p "$LOGS"
git -C "$REPO" fetch -q origin
git -C "$REPO" worktree add -q --detach "$WT" origin/multiplayer || exit 2
cd "$WT" || exit 2
echo "base: $(git rev-parse --short HEAD)"
for sha in "$@"; do
  git merge -q --no-edit "$sha" || { echo "MERGE CONFLICT at $sha"; git status --short | head -20; exit 1; }
done
echo "tree: $(git rev-parse 'HEAD^{tree}')"
npm ci --no-audit --no-fund > "$LOGS/$name-npm-ci.log" 2>&1 || { echo "npm ci failed"; tail -20 "$LOGS/$name-npm-ci.log"; exit 2; }
# src/cli/completion.test.ts fails without the stamp the installer writes beside the packages.
cat package.json package-lock.json | sha256sum | cut -d" " -f1 > node_modules/.nexus-lockfile-sha256
echo "--- tsc"; npx tsc --noEmit -p . 2>&1 | tail -5; echo "tsc exit ${PIPESTATUS[0]}"
echo "--- build"; npm run build 2>&1 | tail -1
echo "--- npm test"; npm test > "$LOGS/$name-test.log" 2>&1; echo "npm test exit $?"
grep -E '^ℹ (tests|pass|fail|skipped)' "$LOGS/$name-test.log"
grep -E '^✖' "$LOGS/$name-test.log" | sort -u | cut -c1-110
# Exit 0: every rule holds. Exit 3: the rules hold and a covered file changed, so confirm after the merge. Needs Java.
echo "--- model"; node .claude/skills/verify-landing-model/scripts/check.mjs 2>&1 | tail -2; echo "model exit ${PIPESTATUS[0]}"
