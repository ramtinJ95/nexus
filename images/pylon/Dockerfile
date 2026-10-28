# The base pylon image's root filesystem. buildImage (src/image-build.ts) passes the versions in pins.json as
# build args, then gondolin build turns the result into the guest rootfs with Alpine's kernel and initramfs.
# PATH and NODE_EXTRA_CA_CERTS live in gondolin.json's env, because only Gondolin's env reaches sandboxd's
# execs as well as login shells. Logins and secrets are never in the image.
ARG DEBIAN_DIGEST
FROM debian:bookworm-slim@${DEBIAN_DIGEST}

# openssh-server is for vm.enableSsh (S2) and stays disabled. Its host keys are removed so that every pylon
# gets its own from enableSsh's ssh-keygen -A. openssh-client is for git over Gondolin's SSH proxy, and the
# boot path adds its config under the stock ssh_config's Include of /etc/ssh/ssh_config.d. procps gives
# enableSsh's script `ps`, e2fsprogs gives Gondolin resize2fs for rootfs growth, and ripgrep and fd are
# installed because pi's own download of them cannot pass the allowlist. xz-utils unpacks Node, and Node 26's
# binary links libatomic. tini is PID 1 (rootfs-init-extra.sh), because sandboxd, which Gondolin's /init would
# exec there, does not reap the orphans it adopts. kmod is for nexus-kvm, which loads the KVM modules only in a
# pylon that asks for nested virtualization.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash coreutils util-linux ca-certificates git python3 openssh-server openssh-client sudo curl \
      procps e2fsprogs ripgrep fd-find xz-utils libatomic1 tini kmod \
 && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

RUN useradd --create-home --uid 1000 --shell /bin/bash user \
 && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user \
 && chmod 0440 /etc/sudoers.d/user \
 && install -d -o user -g user /home/user/workspace

ARG NODE_VERSION
ARG NODE_SHA256
RUN cd /tmp \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  node-v${NODE_VERSION}-linux-x64.tar.xz" | sha256sum -c - \
 && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
 && rm "node-v${NODE_VERSION}-linux-x64.tar.xz"

ARG CLAUDE_CODE_VERSION
ARG PI_VERSION
RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

# The pi-env daemon the harness runs tools through, baked instead of uploaded over SSH at each start. It is a
# static binary, so only its pinned version and checksum matter.
ARG PI_ENV_VERSION
ARG PI_ENV_SHA256
RUN cd /tmp \
 && curl -fsSLo pi-env.tgz "https://registry.npmjs.org/@earendil-works/pi-env/-/pi-env-${PI_ENV_VERSION}.tgz" \
 && tar -xzf pi-env.tgz package/bin/pi-env-linux-x64/pi-env \
 && echo "${PI_ENV_SHA256}  package/bin/pi-env-linux-x64/pi-env" | sha256sum -c - \
 && install -D -o root -g root -m 0755 package/bin/pi-env-linux-x64/pi-env /usr/local/libexec/nexus/pi-env \
 && rm -r pi-env.tgz package

# The installer only installs Herdr's latest release, so a pin that is no longer latest fails here rather than
# building a different Herdr under the same image ID.
ARG HERDR_VERSION
RUN curl -fsSL https://herdr.dev/install.sh -o /tmp/herdr-install.sh \
 && HERDR_INSTALL_DIR=/usr/local/bin sh /tmp/herdr-install.sh \
 && rm /tmp/herdr-install.sh \
 && installed="$(herdr --version)" \
 && if [ "$installed" != "herdr ${HERDR_VERSION}" ]; then echo "Herdr's installer installed '$installed', but pins.json pins ${HERDR_VERSION}. Update the herdr pin" >&2; exit 1; fi

# gh from its release tarball, checked like Node. git asks gh for github.com credentials, and gh reads GH_TOKEN
# when git asks, so the placeholder that Gondolin mints on each boot is never stored. The helper lives in
# /etc/gitconfig, which no dotfiles layer replaces.
ARG GH_VERSION
ARG GH_SHA256
RUN cd /tmp \
 && curl -fsSLo gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  gh.tgz" | sha256sum -c - \
 && tar -xzf gh.tgz \
 && install -m 0755 "gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -r gh.tgz "gh_${GH_VERSION}_linux_amd64" \
 && git config --system credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'

# Neovim for the review-pane mod, which needs 0.10 or later where bookworm ships 0.7. Its release tarball is
# checked and unpacked into /usr/local like Node's, so nvim finds its runtime at ../share/nvim/runtime from its binary.
ARG NEOVIM_VERSION
ARG NEOVIM_SHA256
RUN cd /tmp \
 && curl -fsSLo nvim.tgz "https://github.com/neovim/neovim/releases/download/v${NEOVIM_VERSION}/nvim-linux-x86_64.tar.gz" \
 && echo "${NEOVIM_SHA256}  nvim.tgz" | sha256sum -c - \
 && tar -xzf nvim.tgz -C /usr/local --strip-components=1 --no-same-owner \
 && rm nvim.tgz

# COPY keeps each file's mode, which the recipe carries from git.
COPY nexus /usr/local/bin/nexus
COPY nexus-claude-hook /usr/local/bin/nexus-claude-hook
COPY nexus-heartbeat.ts /usr/local/bin/nexus-heartbeat.ts
COPY nexus-outbox.ts /usr/local/bin/nexus-outbox.ts
COPY nexus-turn.ts /usr/local/bin/nexus-turn.ts
COPY nexus-kvm /usr/local/libexec/nexus/nexus-kvm
COPY checkout-files.py /usr/local/lib/nexus/checkout-files.py
# The common dotfiles layer as a git repository, which the boot path clones into ~/.nexus/dotfiles and then
# updates by fetch. It is owned by user because git refuses to clone a local repository another user owns.
# The recipe carries files, not git objects, so its one commit names the upstream commit instead of being it,
# with a fixed author and date so that the same files give the same commit.
ARG DOTFILES_COMMIT
COPY --chown=user:user dotfiles/ /opt/nexus/dotfiles/

USER user
WORKDIR /home/user
RUN cd /opt/nexus/dotfiles \
 && git init -q -b main \
 && git add -A \
 && GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z \
    git -c user.name=nexus -c user.email=nexus@pylon commit -q -m "dotfiles common layer at ${DOTFILES_COMMIT}"
# This Mac's Claude Code plugins, skills, pi packages and pi extensions, which src/agent-setup.ts captured into
# agent-setup/manifest.json. The installer fetches and installs what the manifest pins, then runs Herdr's
# integrations, the order every boot repeats, so Herdr's hook merges into the settings.json that the plugin
# installs wrote. It fails the build on any difference from the manifest. pi and Claude Code make their config
# directories on first run, and Herdr's installers refuse to run before that.
COPY --chown=user:user agent-setup/ /opt/nexus/agent-setup/
RUN mkdir -p /home/user/.pi/agent/extensions /home/user/.claude /home/user/.agents/skills \
 && node /opt/nexus/agent-setup/install.ts \
 && npm cache clean --force
# The overlay writes ~/.nexus/PYLON.md on every spawn. Claude Code imports it, and pi, which has no import, reads
# it through the link. A dotfiles layer that installs either file must keep this.
RUN printf '@~/.nexus/PYLON.md\n' > /home/user/.claude/CLAUDE.md \
 && ln -s /home/user/.nexus/PYLON.md /home/user/.pi/agent/AGENTS.md
# Nexus relaunches each pane's agent on wake (src/sessions.ts) and checks that it runs. Herdr's own resume on
# restore would start it first, and when that start fails, as `claude --resume` does for a session never
# prompted, Herdr still reports the agent as running. Without `onboarding = false`, Herdr's first-run dialog covers
# the session on the first attach to every new pylon.
RUN mkdir -p /home/user/.config/herdr \
 && printf 'onboarding = false\n\n[session]\nresume_agents_on_restore = false\n' > /home/user/.config/herdr/config.toml
