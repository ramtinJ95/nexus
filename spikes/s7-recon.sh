#!/usr/bin/env bash
# Read-only recon. Run through the SOCKS SSH route documented in S7.md.
# No credential files, VM disks, Docker mutations, or host changes.
set -u
printf 'KERNEL='; uname -sr
printf 'ARCH='; uname -m
printf 'CPU_MODEL='; awk -F ': ' '/^model name/ {print $2; exit}' /proc/cpuinfo
printf 'CPU_FLAGS_SUMMARY='
awk -F ': ' '/^flags/ {n=split($2,a," "); for(i=1;i<=n;i++) if(a[i] ~ /^(vmx|svm|ept|npt|sse2|avx|avx2|avx512f|aes|constant_tsc|nonstop_tsc)$/) printf "%s ",a[i]; print ""; exit}' /proc/cpuinfo
# Identity was compared in the initial recon; do not publish personal identifiers.
printf 'USERNAME=<redacted>\nHOME=/home/<redacted>\n'
ls -l /dev/kvm
if test -r /dev/kvm && test -w /dev/kvm; then echo KVM_RW=yes; else echo KVM_RW=no; fi
printf 'HOME_AVAILABLE_BYTES='; df -B1 --output=avail "$HOME" | tail -1 | tr -d ' '; echo
for tool in docker node qemu-img qemu-system-x86_64 podman; do
  printf '%s=' "$tool"; command -v "$tool" || echo absent
done
printf 'DOCKER_SERVER_VERSION\n'
docker version --format '{{.Server.Version}}' 2>&1; echo "DOCKER_VERSION_EXIT=$?"
printf 'DOCKER_SOCKET\n'; ls -l /var/run/docker.sock
if test -r /var/run/docker.sock && test -w /var/run/docker.sock; then echo DOCKER_SOCKET_RW=yes; else echo DOCKER_SOCKET_RW=no; fi
if id -nG | tr ' ' '\n' | grep -qx docker; then echo DOCKER_GROUP_MEMBER=yes; else echo DOCKER_GROUP_MEMBER=no; fi
printf 'DOCKER_IMAGE_IDS\n'
docker image ls -aq --no-trunc 2>&1; echo "DOCKER_IMAGES_EXIT=$?"
printf 'DOCKER_CONTAINER_IDS\n'
docker container ls -aq --no-trunc 2>&1; echo "DOCKER_CONTAINERS_EXIT=$?"
if test -e "$HOME/nexus-spikes/s7"; then echo S7_ABSENT=no; else echo S7_ABSENT=yes; fi
