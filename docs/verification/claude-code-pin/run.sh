#!/usr/bin/env bash
# Usage: run.sh <checkout> <base ref> <scratch dir>
# Loads the image recipe at <base ref> and in the checkout with the checkout's loadImageRecipe, as the control
# plane does, and prints each recipe's Claude Code and Node pins, its image ID and the smoke boot's expected
# `claude --version`. Then installs the checkout's pinned Claude Code from npm into the scratch dir and passes its
# real `claude --version` output to the smoke boot's check.
set -euo pipefail
checkout=$(cd "$1" && pwd) base=$2 scratch=$3
rm -rf "$scratch" && mkdir -p "$scratch/base" "$scratch/claude"
git -C "$checkout" archive "$base" images/pylon | tar -x -C "$scratch/base"
cat > "$scratch/recipe.ts" <<TS
import { loadImageRecipe, smokeChecks, smokeFailure } from "$checkout/src/image-build.ts";
import { imageIdOf } from "$checkout/src/images.ts";
const [dir, versionOutput] = process.argv.slice(2);
const recipe = await loadImageRecipe(dir);
const check = smokeChecks(recipe).find((c) => c.name === "claude version")!;
console.log(\`  claudeCode \${recipe.pins.claudeCode}\n  node       \${recipe.pins.node}\n  image      \${imageIdOf(recipe)}\`);
console.log(\`  smoke      claude --version must print \${JSON.stringify(check.expect)}\`);
if (versionOutput !== undefined) console.log(\`  verdict    \${JSON.stringify(versionOutput)}: \${smokeFailure(check, 0, versionOutput) ?? "passes"}\`);
TS
echo "recipe at $base ($(git -C "$checkout" rev-parse --short "$base")):"
node "$scratch/recipe.ts" "$scratch/base/images/pylon/"
pin=$(node -p "require('$checkout/images/pylon/pins.json').claudeCode")
npm install --silent --no-audit --no-fund --prefix "$scratch/claude" "@anthropic-ai/claude-code@$pin"
output=$(DISABLE_AUTOUPDATER=1 "$scratch/claude/node_modules/.bin/claude" --version)
echo "recipe in the checkout at $(git -C "$checkout" rev-parse --short HEAD):"
node "$scratch/recipe.ts" "$checkout/images/pylon/" "$output"$'\n'
