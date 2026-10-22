#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
echo 'GUEST_ROOT_PROVISION_START'
cat /etc/os-release
id
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl bash python3 xz-utils git procps openssh-client openssh-server util-linux passwd
# Install the official Node tarball inside the guest, never on the host PATH.
version=v24.22.1
archive="node-$version-linux-x64.tar.xz"
mkdir -p /opt/nexus-downloads
cd /opt/nexus-downloads
curl -fsSL --connect-timeout 15 --max-time 120 "https://nodejs.org/dist/$version/$archive" -o "$archive"
curl -fsSL --connect-timeout 15 --max-time 30 "https://nodejs.org/dist/$version/SHASUMS256.txt" -o SHASUMS256.txt
grep " $archive\$" SHASUMS256.txt | sha256sum -c -
tar -xJf "$archive" -C /usr/local --strip-components=1
id user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash user
mkdir -p /home/user/workspace/repo /home/user/nexus-spikes
chown -R user:user /home/user
ls -ld /etc/gondolin /etc/gondolin/mitm /etc/gondolin/mitm/ca.crt /run/gondolin /run/gondolin/ca-certificates.crt
runuser -u user -- sh -c 'test -r /etc/gondolin/mitm/ca.crt; echo USER_MITM_CA_READABLE_EXIT=$?; test -r /run/gondolin/ca-certificates.crt; echo USER_RUNTIME_CA_READABLE_EXIT=$?'
# The direct MITM VFS mount is inaccessible to the non-root user. Use Gondolin's
# documented merged runtime CA bundle for npm provisioning; S2 still tests the
# exact requested /etc/gondolin/mitm/ca.crt path, without hiding this limitation.
runuser -u user -- env HOME=/home/user XDG_CACHE_HOME=/home/user/.cache PI_SANDBOX_HOME=/home/user/.pi-sandbox npm_config_cache=/home/user/nexus-spikes/npm-cache \
  NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt npm_config_fetch_retries=0 npm install --prefix /home/user/nexus-spikes @anthropic-ai/claude-code
ln -sf /home/user/nexus-spikes/node_modules/.bin/claude /usr/local/bin/claude
curl -fsSL --connect-timeout 15 --max-time 60 https://herdr.dev/install.sh -o /opt/nexus-downloads/herdr-install.sh
HERDR_INSTALL_DIR=/usr/local/bin sh /opt/nexus-downloads/herdr-install.sh
echo 'GUEST_ROOT_PROVISION_COMPLETE'
