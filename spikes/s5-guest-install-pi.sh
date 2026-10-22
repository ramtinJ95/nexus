#!/bin/bash
set -euo pipefail
test "$(id -un)" = user
test "$HOME" = /home/user
cd /home/user/workspace/repo
id
node --version
npm --version
npm install -g --prefix /home/user/.local @earendil-works/pi-coding-agent@latest

# Bash reads only the first existing login profile. Do not replace its contents.
profile="$HOME/.profile"
if test -f "$HOME/.bash_profile"; then
  profile="$HOME/.bash_profile"
elif test -f "$HOME/.bash_login"; then
  profile="$HOME/.bash_login"
fi
if ! grep -qF '# Nexus S5: user-local npm binaries' "$profile"; then
  printf '\n# Nexus S5: user-local npm binaries\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$profile"
fi

# Start without .local/bin in inherited PATH, to test the actual login profile.
env PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin bash --login -c '
  set -e
  test "$(id -un)" = user
  test "$(command -v pi)" = /home/user/.local/bin/pi
  printf "LOGIN_PI_PATH="; command -v pi
  printf "PI_VERSION="; pi --version
'
