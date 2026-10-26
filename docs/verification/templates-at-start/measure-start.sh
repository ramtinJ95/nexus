#!/usr/bin/env bash
# Times the guest-side work of a thread's first boot both ways, with the commands pylon-vm-backend.ts runs:
# fresh is setupCommands (clone, check out, .nexus/setup), template is a copy of a set-up checkout plus
# checkoutCommands (fetch, check out the thread's commit). The VM boot is not timed. The template's disk is one qcow2
# file that copyFile clones with FICLONE, so a one-file copy of the set-up checkout's bytes, `cp --reflink=auto` of a tar
# of it, stands in for it. Also times the control plane's read of .nexus/setup at thread start.
# Usage: measure-start.sh <nexus checkout> <work dir> [runs]
set -euo pipefail
src=$(realpath "$1"); work=$2; runs=${3:-5}
rm -rf "$work"; mkdir -p "$work"; work=$(realpath "$work")
origin=$work/origin.git url=file://$work/origin.git

git clone --quiet --bare "$src" "$origin"
seed=$work/seed
git clone --quiet "$url" "$seed"
mkdir -p "$seed/.nexus"
printf '#!/usr/bin/env bash\nset -euo pipefail\nnpm ci --no-audit --no-fund --update-notifier=false --loglevel=error\n' > "$seed/.nexus/setup"
chmod +x "$seed/.nexus/setup"
git -C "$seed" add .nexus/setup && git -C "$seed" -c user.name=bench -c user.email=bench@example.com commit --quiet -m "chore: setup runs npm ci"
built=$(git -C "$seed" rev-parse HEAD)
echo "// $(date -u +%FT%TZ)" >> "$seed/src/tick.ts"
git -C "$seed" -c user.name=bench -c user.email=bench@example.com commit --quiet -am "chore: a commit after the template"
target=$(git -C "$seed" rev-parse HEAD)
git -C "$seed" push --quiet origin HEAD:main

fresh() { # $1 dir, $2 commit
  local cache; cache=$(mktemp -d)
  git clone --quiet --no-checkout "$url" "$1" && git -C "$1" checkout --quiet -B main "$2" && git -C "$1" update-ref refs/nexus/base HEAD
  (cd "$1" && npm_config_cache=$cache ./.nexus/setup)
  rm -rf "$cache"
}
fresh "$work/template" "$built"
tar -C "$work/template" -cf "$work/disk.tar" .
echo "template built at ${built:0:12}, threads check out ${target:0:12}, template disk stand-in $(du -h "$work/disk.tar" | cut -f1)"

check() { # $1 dir: the thread's commit, a clean tree, and setup's output
  test "$(git -C "$1" rev-parse HEAD)" = "$target" || { echo "FAIL $1 is at $(git -C "$1" rev-parse HEAD)"; exit 1; }
  test "$(git -C "$1" rev-parse refs/nexus/base)" = "$target" || { echo "FAIL $1 base"; exit 1; }
  test -z "$(git -C "$1" status --porcelain --untracked-files=no)" || { echo "FAIL $1 has tracked changes"; exit 1; }
  test -x "$1/node_modules/.bin/tsc" || { echo "FAIL $1 has no node_modules"; exit 1; }
}
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }

for i in $(seq "$runs"); do
  d=$work/fresh-$i; t0=$(date +%s%N); fresh "$d" "$target"; f=$(ms "$t0"); check "$d"; rm -rf "$d"
  d=$work/tpl-$i; cp -a "$work/template" "$d"; sync
  t0=$(date +%s%N); cp --reflink=auto "$work/disk.tar" "$d.tar"; sync; c=$(ms "$t0"); rm "$d.tar"
  t1=$(date +%s%N)
  (cd "$d" && git remote set-url origin "$url" && git fetch --quiet origin && git checkout --quiet -B main "$target" && git update-ref refs/nexus/base HEAD)
  k=$(ms "$t1"); check "$d"; rm -rf "$d"
  echo "run $i: fresh ${f} ms, template $((c + k)) ms (disk copy ${c} ms, checkout ${k} ms)"
done

for i in $(seq "$runs"); do
  m=$(mktemp -d); t0=$(date +%s%N)
  git init --quiet --bare "$m" && git -C "$m" fetch --quiet --depth=1 --filter=blob:none https://github.com/ramtinJ95/nexus.git refs/heads/main
  git -C "$m" rev-parse --verify 'FETCH_HEAD^{commit}' > /dev/null
  echo "mirror read $i: $(ms "$t0") ms against github.com"; rm -rf "$m"
done
