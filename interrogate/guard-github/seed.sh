#!/bin/sh
# Creates (or reuses) the private scratch repo and tops it up to $WANT open seed pull requests, from the host,
# with the host's gh login. Each seed PR adds its own file, so every one stays mergeable on its own.
set -eu
repo=${SCRATCH_REPO:-ramtinJ95/nexus-guard-scratch}
want=${WANT:-10}
if ! gh repo view "$repo" >/dev/null 2>&1; then
  gh repo create "$repo" --private --add-readme --description "throwaway: Nexus egress guard prototype" >/dev/null
  sleep 2
fi
gh api -X PATCH "repos/$repo" -F allow_auto_merge=true -F delete_branch_on_merge=false >/dev/null
open=$(gh pr list -R "$repo" --state open --search "head:seed-" --json number --jq length)
while [ "$open" -lt "$want" ]; do
  b="seed-$(date +%s%N | tail -c 9)"
  main=$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha)
  gh api "repos/$repo/git/refs" -f ref="refs/heads/$b" -f sha="$main" >/dev/null
  gh api -X PUT "repos/$repo/contents/$b.txt" -f message="add $b" -f content="$(printf '%s\n' "$b" | base64)" -f branch="$b" >/dev/null
  gh api "repos/$repo/pulls" -f title="seed $b" -f head="$b" -f base=main -f body="seed PR for guard probes" --jq '"#\(.number) \(.head.ref)"'
  open=$((open + 1))
done
gh pr list -R "$repo" --state open --json number,headRefName --jq '.[] | "#\(.number) \(.headRefName)"' | tr '\n' ' '
echo
