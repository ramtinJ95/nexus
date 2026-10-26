#!/bin/sh
# Drives the stack in stack.ts with the real CLI, asserts each expectation, and writes each capture beside this script.
#   node docs/verification/templates-at-start/stack.ts & sleep 5; sh docs/verification/templates-at-start/drive.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
export NEXUS_URL=http://127.0.0.1:7470 NEXUS_SOCKS=none
nexus() { node "$here/../../../src/cli/nexus.ts" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
expect() { [ "$1" = "$2" ] || fail "$3: got '$1', want '$2'"; }
has() { grep -qF -- "$2" "$1" || fail "$1 does not say: $2"; }
# A dotted path into a JSON file, such as thread.setup.commit. A missing field prints nothing.
field() { node -e 'let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); for (const k of process.argv[2].split(".")) v = v?.[k]; console.log(v ?? "")' "$1" "$2"; }
# The registry's template records, read-only. No API lists templates, so the wait for a build reads the registry.
templates() { node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(JSON.stringify(db.prepare("SELECT record FROM templates ORDER BY id").all().map((r) => JSON.parse(r.record)), null, 2))' /tmp/nexus-templates/registry.db; }
ready() {
  for _ in $(seq 60); do
    [ "$(templates | node -e 'const t = JSON.parse(require("fs").readFileSync(0, "utf8")).find((t) => t.id === process.argv[1]); console.log(t?.state ?? "")' "$1")" = ready ] && return 0
    sleep 1
  done
  fail "template $1 was not ready within 60 s"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git init -q --bare --initial-branch=main "$work/origin.git"
# As GitHub does, so the mirror's fetch can leave blobs out.
git -C "$work/origin.git" config uploadpack.allowFilter true
git clone -q "$work/origin.git" "$work/clone" 2>/dev/null
g() { git -C "$work/clone" -c user.name=Verifier -c user.email=verify@example.com "$@"; }
mkdir "$work/clone/.nexus"
printf '#!/bin/sh\nnpm ci\n' > "$work/clone/.nexus/setup"
chmod +x "$work/clone/.nexus/setup"
echo "acme" > "$work/clone/README.md"
g add . && g commit -q -m "npm ci in setup" && g push -q origin main
first=$(g rev-parse HEAD)

nexus --version > "$here/version.txt"
expect "$(cat "$here/version.txt")" "nexus 0.23.0" "CLI version"
nexus project add acme "file://$work/origin.git" --node local-node --cpus 2 --memory 4 --disk 10 > "$here/project-add.txt"

start() { nexus start --project acme --json "$@"; }
show() { nexus show "$1" > "$here/show-$2.txt"; nexus show "$1" --json > "$here/show-$2.json"; }

start --title "A: first thread of the setup" > "$here/start-a.json"
a=$(field "$here/start-a.json" id)
show "$a" a
expect "$(field "$here/show-a.json" thread.setup.how)" fresh "A boots fresh"
tpl=$(field "$here/show-a.json" thread.setup.building)
case "$tpl" in tpl-*) ;; *) fail "A names no template build: '$tpl'" ;; esac
has "$here/show-a.txt" "setup: fresh boot runs .nexus/setup, because no template of this setup is on local-node yet; $tpl builds for the next thread"
ready "$tpl"
expect "$(field "$here/builds.json" 0.template)" "$tpl" "the probe built A's template"
expect "$(field "$here/builds.json" 0.inputs.repo.commit)" "$first" "the build checks out the commit A's setup was read at"

echo "second commit, setup untouched" >> "$work/clone/README.md"
g commit -q -am "README only" && g push -q origin main
second=$(git -C "$work/origin.git" rev-parse main)
start --title "B: branch tip moved, same setup" > "$here/start-b.json"
b=$(field "$here/start-b.json" id)
show "$b" b
expect "$(field "$here/show-b.json" thread.setup.how)" template "B boots from the template"
expect "$(field "$here/show-b.json" thread.setup.template)" "$tpl" "B's template is A's build"
expect "$(field "$here/show-b.json" thread.setup.commit)" "$second" "B checks out the new tip, not the template's build commit"
has "$here/show-b.txt" "setup: from template $tpl, built "
has "$here/show-b.txt" ", then checked out $(echo "$second" | cut -c1-12)"

start --title "C: full first commit" --commit "$first" > "$here/start-c.json"
c=$(field "$here/start-c.json" id)
show "$c" c
expect "$(field "$here/show-c.json" thread.setup.how)" template "C boots from the template"
expect "$(field "$here/show-c.json" thread.setup.template)" "$tpl" "C's template is A's build"
expect "$(field "$here/show-c.json" thread.setup.commit)" "$first" "C checks out the commit it named"
has "$here/show-c.txt" "setup: from template $tpl, built "
has "$here/show-c.txt" ", then checked out $(echo "$first" | cut -c1-12)"

short=$(echo "$first" | cut -c1-7)
start --title "D: short commit" --commit "$short" > "$here/start-d.json"
d=$(field "$here/start-d.json" id)
show "$d" d
expect "$(field "$here/show-d.json" thread.setup.how)" fresh "D boots fresh"
expect "$(field "$here/show-d.json" thread.setup.building)" "" "D asks for no build"
has "$here/show-d.txt" "setup: fresh boot runs .nexus/setup, because the start named commit $short, and only a full commit ID or a branch tip can use a template"

printf '#!/bin/sh\nnpm ci && npm run build\n' > "$work/clone/.nexus/setup"
g commit -q -am "build in setup" && g push -q origin main
third=$(git -C "$work/origin.git" rev-parse main)
start --title "E: setup changed" > "$here/start-e.json"
e=$(field "$here/start-e.json" id)
show "$e" e
expect "$(field "$here/show-e.json" thread.setup.how)" fresh "E boots fresh"
tpl2=$(field "$here/show-e.json" thread.setup.building)
case "$tpl2" in tpl-*) ;; *) fail "E names no template build: '$tpl2'" ;; esac
[ "$tpl2" != "$tpl" ] || fail "E's setup changed, yet it builds $tpl again"
has "$here/show-e.txt" "setup: fresh boot runs .nexus/setup, because no template of this setup is on local-node yet; $tpl2 builds for the next thread"
ready "$tpl2"
expect "$(field "$here/builds.json" 1.template)" "$tpl2" "the probe built E's template"
expect "$(field "$here/builds.json" 1.inputs.repo.commit)" "$third" "E's build checks out E's commit"
expect "$(field "$here/builds.json" 2.template)" "" "no other build ran"

for _ in $(seq 30); do [ "$(field "$here/spawns.json" "pylon-$b.source.kind")" != "" ] && break; sleep 1; done
expect "$(field "$here/spawns.json" "pylon-$a.source.kind")" fresh "A's spawn boots fresh"
expect "$(field "$here/spawns.json" "pylon-$b.source.kind")" template "B's spawn boots from a template"
expect "$(field "$here/spawns.json" "pylon-$b.source.template")" "$tpl" "B's spawn names A's template"
expect "$(field "$here/spawns.json" "pylon-$b.repo.checkout.commit")" "$second" "B's spawn checks out the new tip"
expect "$(field "$here/spawns.json" "pylon-$c.source.template")" "$tpl" "C's spawn names A's template"
expect "$(field "$here/spawns.json" "pylon-$c.repo.checkout.commit")" "$first" "C's spawn checks out the commit it named"
expect "$(field "$here/spawns.json" "pylon-$d.source.kind")" fresh "D's spawn boots fresh"
# pylon-vm opens the template's disk before it builds the boot spec, whose remote check refuses file:// URLs.
nexus show "$b" > "$here/show-b.txt"
has "$here/show-b.txt" "is neither an SSH nor an HTTPS git URL"

templates > "$here/templates.json"
ls -l /tmp/nexus-templates/artifacts/"$tpl" /tmp/nexus-templates/artifacts/"$tpl2" > "$here/artifacts.txt"
cat /tmp/nexus-templates/artifacts/"$tpl"/template.json >> "$here/artifacts.txt"
nexus threads > "$here/threads.txt"
printf 'first  %s\nsecond %s\nthird  %s\n' "$first" "$second" "$third" > "$here/commits.txt"
echo "all expectations held"
