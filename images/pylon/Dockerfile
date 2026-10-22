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
# installed because pi's own download of them cannot pass the allowlist. xz-utils unpacks Node. Gondolin's
# /init execs sandboxd as PID 1, which does not reap the orphans it adopts, so long-lived process trees such
# as the Herdr server run under `tini -s --`, which reaps everything under them.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash coreutils util-linux ca-certificates git python3 openssh-server openssh-client sudo curl \
      procps e2fsprogs ripgrep fd-find xz-utils tini \
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

COPY --chmod=0755 nexus /usr/local/bin/nexus
# The common dotfiles layer as a git repository, which the boot path clones into ~/.nexus/dotfiles and then
# updates by fetch. It is owned by user because git refuses to clone a local repository another user owns.
# The recipe carries files, not git objects, so its one commit names the upstream commit instead of being it,
# with a fixed author and date so that the same files give the same commit. Recipe files carry no modes, so
# the layer's install script gets its exec bit here.
ARG DOTFILES_COMMIT
COPY --chown=user:user dotfiles/ /opt/nexus/dotfiles/

USER user
WORKDIR /home/user
RUN cd /opt/nexus/dotfiles \
 && if [ -e install ]; then chmod 0755 install; fi \
 && git init -q -b main \
 && git add -A \
 && GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z \
    git -c user.name=nexus -c user.email=nexus@pylon commit -q -m "dotfiles common layer at ${DOTFILES_COMMIT}"
# pi and Claude Code make their config directories on first run, and Herdr's installers refuse to run before that.
RUN mkdir -p /home/user/.pi/agent/extensions /home/user/.claude \
 && herdr integration install pi \
 && herdr integration install claude
