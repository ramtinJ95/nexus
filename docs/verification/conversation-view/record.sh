#!/usr/bin/env bash
# Records the two Claude Code sessions whose transcripts the captures show, each in its own worktree of this repo
# at the given commit, and saves the records the transcript parser reads as fixtures/claude-worker.jsonl and
# fixtures/harness-source.jsonl, with the worktree's path written as the pylon's checkout. It needs a logged-in
# Claude Code: run it from a login shell in a pylon, where CLAUDE_CODE_OAUTH_TOKEN is set.
#
#   docs/verification/conversation-view/record.sh [commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'for w in claude-worker harness-source; do git -C "$repo" worktree remove --force "$work/$w" 2>/dev/null || true; done; rm -rf "$work"' EXIT

worker=(
  "agoText in src/control/dashboard/ago.js should say \"never\" for at = 0, as the server's ago() in src/control/dashboard.ts does. Work test first: read both, write src/control/dashboard/ago.test.js in the style of the other *.test.js files in that folder covering every boundary and the never case, run it with node --test and watch the never case fail, then fix ago.js and run the test again. Then run npm run typecheck. Do not commit."
  "Now run every test in src/control/dashboard with node --test src/control/dashboard/*.test.js, then show me git diff, and sum up the change in three sentences."
)
harness=(
  "Find out how the dashboard folds a run of tool calls into one line. Read stepsSummary and toolLooks in src/control/dashboard.ts, find their tests in src/control/dashboard.test.ts with grep, and run node --test --test-name-pattern=fold src/control/dashboard.test.ts (run npm run build first if it needs the bundle). Then set phrasesShown to 2, run that test again to see what breaks, and put it back. Report in a few sentences. Do not commit."
  "Which Claude Code tool names in src/fixtures/claude-transcript.jsonl have no entry in toolLooks? Check with jq or grep, list them, and say how each would read in a fold today."
  "Give mcp__notes-compaction__notes a look in toolLooks so a fold says it took notes: use the Edit tool on src/control/dashboard.ts (no sed), adding a \"notes\" action whose phrases are \"took notes\" and \"took notes N times\". Run node --test --test-name-pattern=fold src/control/dashboard.test.ts and npm run typecheck as plain commands without pipes. If anything fails, fix it with Edit and run it again. Then show git diff --stat and revert your change with git checkout. Do not commit."
)

record() {
  local name=$1; shift
  local tree="$work/$name" session=
  git -C "$repo" worktree add --detach "$tree" "${COMMIT:-HEAD}" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  for prompt in "$@"; do
    out=$(cd "$tree" && CLAUDE_CONFIG_DIR="$work/claude" claude -p "$prompt" ${session:+--resume "$session"} --model sonnet \
      --permission-mode bypassPermissions --strict-mcp-config --output-format json)
    session=$(node -e 'console.log(JSON.parse(process.argv[1]).session_id)' "$out")
  done
  node -e '
    const [file, tree, out] = process.argv.slice(1);
    const kept = new Set(["user", "assistant", "queue-operation", "system"]);
    const lines = require("fs").readFileSync(file, "utf8").split("\n").filter((l) => l !== "" && kept.has(JSON.parse(l).type));
    require("fs").writeFileSync(out, lines.join("\n").replaceAll(tree, "/home/user/workspace/repo") + "\n");
  ' "$(find "$work/claude/projects" -name "$session.jsonl")" "$tree" "$here/fixtures/$name.jsonl"
}
COMMIT=${1:-HEAD}
record claude-worker "${worker[@]}" &
record harness-source "${harness[@]}" &
wait
