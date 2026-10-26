#!/bin/sh
# Drives the stack in stack.ts with the real CLI and writes each capture beside this script.
#   node docs/verification/image-rollout/stack.ts > /tmp/nir.log & sleep 5
#   sh docs/verification/image-rollout/drive.sh $!
set -u
here=$(dirname "$0")
stack=$1
export NEXUS_URL=http://127.0.0.1:7470 NEXUS_SOCKS=none
nexus() { node "$here/../../../src/cli/nexus.ts" "$@"; }
step() { out="$here/$1.txt"; shift; { echo "\$ nexus $*"; nexus "$@"; echo "exit $?"; } > "$out" 2>&1; }

nexus --version > "$here/version.txt"
step 01-list-before image list
echo nCONTROL > /tmp/nir/caller
step 02-build-as-control-node image build
echo nLAPTOP > /tmp/nir/caller
step 03-build image build --wait
new=$(nexus image list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).operation.image))')
step 04-build-again image build
step 05-rollout-nuc-fails image rollout "$new" --wait
step 06-current-after-failure image current
kill -USR2 "$stack"
sleep 6
step 07-nodes-nuc-offline nodes
step 08-rollout image rollout "$new" --wait
step 09-list-after-rollout image list
step 10-list-json image list --json
{
  ls -l /tmp/nir/*/artifacts/
  echo "sha256 of each copy's archive, as the next fetch from it would send it, against the recorded $new:"
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    import { artifactArchive } from "./src/artifacts.ts";
    for (const node of ["infra-testbench", "rj-firebat"]) {
      const hash = createHash("sha256");
      for await (const chunk of artifactArchive(`/tmp/nir/${node}/artifacts/${process.argv[1]}`, "image.json")) hash.update(chunk);
      console.log(`${node}: ${hash.digest("hex")}`);
    }' "$new"
  nexus image list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log("recorded: "+v.images.find(i=>i.id===process.argv[1]).sha256)})' "$new"
} > "$here/11-stores.txt" 2>&1
step 12-rollback image rollback --wait
step 13-current-after-rollback image current
step 14-rollback-forward image rollback --wait
