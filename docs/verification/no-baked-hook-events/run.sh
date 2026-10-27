#!/usr/bin/env bash
# Runs the docker build's agent-setup step, `node install.ts`, from this checkout or the one its argument names, as a
# scratch Linux user in a pylon, then lists the session state it left in that home. NEXUS_API points at a closed port, so no event reaches the
# thread. Needs sudo and the pylon's network (GitHub and the npm registry).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="${1:-$(cd "$here/../../.." && pwd)}"
id builder >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash builder
sudo rm -rf /home/builder/setup /home/builder/.pi /home/builder/.claude /home/builder/.agents /home/builder/.npm /home/builder/.nexus /home/builder/.local /home/builder/.config /home/builder/.cache
sudo -u builder mkdir -p /home/builder/setup /home/builder/.pi/agent/extensions /home/builder/.claude /home/builder/.agents/skills
sudo install -o builder -g builder -m 0644 "$repo"/images/pylon/agent-setup/{install.ts,manifest.ts,manifest.json} /home/builder/setup/
cd /
sudo -u builder env -i HOME=/home/builder USER=builder PATH=/usr/local/bin:/usr/bin:/bin \
  NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt NEXUS_API=http://127.0.0.1:9 node /home/builder/setup/install.ts
sudo bash "$here/session-state.sh" /home/builder
sudo pkill -u builder -f nexus-outbox || true
