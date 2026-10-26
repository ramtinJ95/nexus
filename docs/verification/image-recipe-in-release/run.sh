#!/usr/bin/env bash
# Usage: run.sh <release.sh> <scratch prefix>
set -uo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
script=$1 opt=$2
export NEXUS_COMMIT=$(git -C "$repo" rev-parse HEAD)
bash -c '. "$1"; prefix=$2; install() { mkdir -p "$prefix/releases"; }; chown() { :; }; install_release "$3"' build "$script" "$opt" "$repo" 2>&1 | grep -E "installed release|already installed|fail" 
release=$opt/releases/$NEXUS_COMMIT
sudo chown -R root:root "$release" && sudo chmod -R u+rwX,go+rX,go-w "$release"
echo "release: $release, owner $(stat -c %U "$release/src"), user $(id -un)"
echo "release images/pylon:"; (cd "$release" && find images -type f | LC_ALL=C sort | sed 's/^/  /')
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const [release, repo] = process.argv.slice(1);
const { imageIdOf } = await import(pathToFileURL(`${repo}/src/images.ts`).href);
const checkout = await (await import(pathToFileURL(`${repo}/src/image-build.ts`).href)).loadImageRecipe();
console.log(`checkout recipe: ${imageIdOf(checkout)}, ${checkout.files.length} files`);
try {
  const recipe = await (await import(pathToFileURL(`${release}/src/image-build.ts`).href)).loadImageRecipe();
  console.log(`release recipe:  ${imageIdOf(recipe)}, ${recipe.files.length} files, pins gondolin ${recipe.pins.gondolin}`);
  for (const f of recipe.files) console.log(`  ${f.path} ${f.content.length} bytes${f.content === checkout.files.find((c) => c.path === f.path)?.content ? ", same as checkout" : ", DIFFERS"}`);
} catch (err) { console.log(`release recipe:  nexus: ${err.message}`); }
' "$release" "$repo"
