# The pylon-vm slice test image: Debian bookworm-slim with only what the pylon-vm backend needs in a guest.
# python3 runs every guest command (the fork's process worker), git and ca-certificates clone over HTTPS
# through Gondolin's TLS interception (its init adds its CA with update-ca-certificates), openssh-client
# clones over SSH through Gondolin's SSH termination on the host, and `user` is the pylon user with
# passwordless sudo. /opt/nexus/dotfiles stands in for the baked common dotfiles layer: one commit whose
# `install` records the commit it ran from. As in the pylon image, user owns it, because git refuses to clone a
# local repository another user owns. Not the pylon image: no Node, Herdr, Claude Code or pi.
FROM debian:bookworm-slim
LABEL nexus.pylon-test=slice
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 git ca-certificates sudo openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash user \
 && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user \
 && chmod 0440 /etc/sudoers.d/user \
 && install -d -o user -g user /home/user/workspace \
 && install -d -o user -g user /opt/nexus/dotfiles
USER user
WORKDIR /opt/nexus/dotfiles
RUN printf '#!/bin/sh\ngit rev-parse HEAD > /home/user/.nexus/dotfiles-installed\n' > install \
 && chmod 0755 install \
 && git init -q -b main \
 && git add -A \
 && GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git -c user.name=nexus -c user.email=nexus@pylon commit -q -m "baked slice layer"
USER root
WORKDIR /
