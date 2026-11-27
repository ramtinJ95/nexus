#!/usr/bin/env bash
# Merges a pull request into multiplayer at exactly the head scripts/mp/trial.sh tested, checks that the merged tree
# equals the tested tree, and removes the trial worktree. A slice is squashed. A sync of main is a merge commit: give
# --merge as the fourth argument.
# usage: NEXUS_REPO=<your clone> scripts/mp/merge.sh <pr number> <full head sha> <trial name> [--merge]
set -u
REPO=${NEXUS_REPO:?set NEXUS_REPO to your clone of the repository}
GH_REPO=${NEXUS_GH_REPO:-ramtinJ95/nexus}
pr=$1; sha=$2; WT=$REPO/.claude/worktrees/$3; how=${4:---squash}
cd "${TMPDIR:-/tmp}" || exit 2
tested=$(git -C "$WT" rev-parse 'HEAD^{tree}') || exit 2
gh pr merge "$pr" --repo "$GH_REPO" "$how" --match-head-commit "$sha" || exit 1
git -C "$REPO" fetch -q origin
echo "multiplayer $(git -C "$REPO" rev-parse --short origin/multiplayer)"
merged=$(git -C "$REPO" rev-parse 'origin/multiplayer^{tree}')
[ "$merged" = "$tested" ] && echo "merged tree == tested tree ($merged)" || echo "TREE MISMATCH merged $merged tested $tested"
git -C "$REPO" worktree remove --force "$WT"
rm -f "${TMPDIR:-/tmp}/nexus-mp-trial/$3"-*.log
