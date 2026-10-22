# The pylon-vm slice test image: Debian bookworm-slim with only what the pylon-vm backend needs in a guest.
# python3 runs every guest command (the fork's process worker), git and ca-certificates clone over HTTPS
# through Gondolin's TLS interception (its init adds its CA with update-ca-certificates), and `user`
# is the pylon user with passwordless sudo. Not the pylon image: no Node, Herdr, Claude Code or pi.
FROM debian:bookworm-slim
LABEL nexus.pylon-test=slice
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 git ca-certificates sudo \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash user \
 && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user \
 && chmod 0440 /etc/sudoers.d/user \
 && install -d -o user -g user /home/user/workspace
