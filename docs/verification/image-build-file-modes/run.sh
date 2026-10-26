#!/usr/bin/env bash
# Usage: run.sh <checkout> <scratch dir>
# Runs the checkout's buildImage on its own recipe under the probe unit's UMask=0077, with a docker on PATH that
# stands in for `docker build`: it applies the Dockerfile's COPY lines to a root-owned directory as Docker does,
# keeping each source file's mode unless --chmod sets one, then reads every copied file as user, the image's
# user, and runs the smoke boot's Claude turn snapshot with the copied nexus-turn.ts and checkout-files.py.
# It then fails the build, so nothing else runs.
set -uo pipefail
checkout=$(cd "$1" && pwd) scratch=$2
rm -rf "$scratch" && mkdir -p "$scratch/bin"
cat > "$scratch/bin/docker" <<'SHIM'
#!/usr/bin/env bash
set -uo pipefail
[ "$1" = build ] || exit 0
context=${@: -1} root=$DOCKER_SHIM_ROOT
echo "context as written by buildImage:"
(cd "$context" && find . -mindepth 1 -printf '  %m %p\n' | LC_ALL=C sort -k2)
sudo rm -rf "$root" && sudo install -d -m 0755 "$root"
copied=()
while read -r line; do
  [[ $line == COPY\ * ]] || continue
  read -ra words <<< "${line#COPY }"
  mode= owner=0:0 sources=()
  for word in "${words[@]}"; do
    case $word in
      --chmod=*) mode=${word#--chmod=} ;;
      --chown=user:user) owner=1000:1000 ;;
      *) sources+=("$word") ;;
    esac
  done
  dest=$root${sources[-1]}
  unset 'sources[-1]'
  for source in "${sources[@]}"; do
    if [ -d "$context/$source" ]; then
      sudo install -d -m 0755 "$dest" && sudo cp -r --preserve=mode "$context/$source/." "$dest/"
    else
      sudo install -d -m 0755 "$(dirname "$dest")" && sudo cp --preserve=mode "$context/$source" "$dest"
    fi
    sudo chown -R "$owner" "$dest"
    [ -z "$mode" ] || sudo chmod -R "$mode" "$dest"
    copied+=("$dest")
  done
done < "$context/Dockerfile"
echo "in the image, read as $(id -un):"
for path in "${copied[@]}"; do
  sudo find "$path" -printf '%y %m %u %p\n' | while read -r type mode user file; do
    if [ "$type" = d ]; then [ -x "$file" ] && [ -r "$file" ] && access=ok || access=DENIED
    else [ -r "$file" ] && access=ok || access=DENIED; fi
    echo "  $mode $user ${file#"$root"} $access"
  done
done
echo "Claude turn snapshot:"
d=$(mktemp -d) && git -C "$d" init -q && echo a > "$d/a"
node --input-type=module -e "const { snapshotTurn } = await import(process.argv[2]); console.log(await snapshotTurn(process.argv[1], 'smoke', 60_000, process.argv[3]))" "$d" "$root/usr/local/bin/nexus-turn.ts" "$root/usr/local/lib/nexus/checkout-files.py" 2>&1 | grep -E '^(true|false|Error)' | sed 's/^/  /'
git -C "$d" log -1 --format=%s refs/nexus/turn 2>&1 | sed 's/^/  /'
echo "docker shim: stopping the build after COPY"
exit 1
SHIM
chmod 0755 "$scratch/bin/docker"
echo "checkout $(git -C "$checkout" rev-parse --short HEAD), umask 0077, user $(id -un)"
(
  umask 0077
  PATH="$scratch/bin:$PATH" DOCKER_SHIM_ROOT="$scratch/rootfs" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const [checkout, out] = process.argv.slice(1);
const { buildImage, loadImageRecipe } = await import(pathToFileURL(`${checkout}/src/image-build.ts`).href);
const { imageIdOf } = await import(pathToFileURL(`${checkout}/src/images.ts`).href);
const recipe = await loadImageRecipe();
console.log(`recipe ${imageIdOf(recipe)}`);
try { await buildImage(recipe, "pylon", `${out}/${imageIdOf(recipe)}`, AbortSignal.timeout(120_000)); }
catch (err) { console.log(`buildImage: ${err.message}`); }
' "$checkout" "$scratch/out" 2>&1
)
sudo rm -rf "$scratch"
