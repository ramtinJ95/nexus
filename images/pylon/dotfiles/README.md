This directory is the image's fallback copy of the common dotfiles layer. The image turns it into a git
repository at /opt/nexus/dotfiles, which the boot path clones into ~/.nexus/dotfiles and updates by fetch,
keeping this copy when a fetch fails. It is a placeholder for now.

To fill it, export the common layer of the dotfiles repo at one commit into this directory, with no logins
or secrets, including its `install` script, which the boot path runs as user to link the layer into
~/.claude and ~/.pi/agent. Then set `dotfilesCommon` in ../pins.json to that commit.
