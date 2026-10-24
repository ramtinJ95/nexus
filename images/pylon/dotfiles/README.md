This directory is the image's fallback copy of the common dotfiles layer. The image turns it into a git
repository at /opt/nexus/dotfiles, which the boot path clones into ~/.nexus/dotfiles and updates by fetch,
keeping this copy when a fetch fails. It is a placeholder for now.

To fill it, export the common layer of the dotfiles repo at one commit into this directory, with no logins
or secrets, including its `install` script, which the boot path runs as user to link the layer into
~/.claude and ~/.pi/agent. Then set `dotfilesCommon` in ../pins.json to that commit.

The image owns two files that a layer must not replace without keeping what they do. `~/.claude/CLAUDE.md`
holds `@~/.nexus/PYLON.md`, and `~/.pi/agent/AGENTS.md` is a link to `/home/user/.nexus/PYLON.md`, which each
spawn rewrites. A layer that installs either file keeps that import or link. Skills, Claude Code plugins and pi
packages and extensions do not belong here: the image bakes them from `../agent-setup/manifest.json`, and its
installs record them in ~/.claude/settings.json and ~/.pi/agent/settings.json. A layer merges into those two
files rather than replacing or linking them, as Herdr's integrations do on every boot.
