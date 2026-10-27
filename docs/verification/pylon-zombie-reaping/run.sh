#!/bin/sh
# run.sh <rootfs-init-extra.sh>: runs drive-sandboxd.py with the init tail that Gondolin's /init runs after that
# file, which is its trap and exec lines and then /init's own exec of sandboxd, and judges the smoke check
# "PID 1 reaps orphans" by its expectation in src/image-build.ts.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
extra="$(realpath "$1")"
cd "$here/../../.."
check="$(node --input-type=module -e '
const { smokeChecks, loadImageRecipe } = await import("./src/image-build.ts");
console.log(JSON.stringify(smokeChecks(await loadImageRecipe()).find((c) => c.name === "PID 1 reaps orphans").argv));')"
tail="$( { grep -E '^(trap|exec) ' "$extra" || true; echo 'exec /usr/bin/sandboxd'; } | tr '\n' ';')"
echo "init tail: $tail"
sudo python3 "$here/drive-sandboxd.py" "$tail" "$check" | node --input-type=module -e '
const { smokeChecks, smokeFailure, loadImageRecipe } = await import("./src/image-build.ts");
const check = smokeChecks(await loadImageRecipe()).find((c) => c.name === "PID 1 reaps orphans");
for (const line of (await new Response(process.stdin).text()).trim().split("\n")) {
  const result = JSON.parse(line);
  if (result.name === "smoke check") {
    const failure = result.exitCode === null ? "no answer" : smokeFailure(check, result.exitCode, result.output);
    console.log(`smoke check "${check.name}": ${failure === undefined ? "passed" : `failed, ${failure}`}`);
  } else console.log(`${result.name}: exit ${result.exitCode}${result.pid1 ? `, PID 1 ${result.pid1}` : ""}\n${result.output.trimEnd().replace(/^/gm, "  ")}`);
}'
