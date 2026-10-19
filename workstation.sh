#!/bin/bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mode=${1:---auto}
if [[ $mode == --auto ]]; then
  if [[ -r /etc/os-release ]] && grep -q '^ID=chainguard$' /etc/os-release; then
    mode=--remote
  elif [[ -f "$HOME/.ssh/config" ]] && grep -Eq '^[[:space:]]*(Host[[:space:]]+workstation([[:space:]]|$)|Include.*config.d/workstation)' "$HOME/.ssh/config"; then
    mode=--local
  else
    exit 0
  fi
fi

# Older Stow installs folded systemd directories into the repository.
for rel in systemd systemd/user systemd/user/default.target.wants systemd/user/sockets.target.wants systemd/user/graphical-session.target.wants; do
  directory="$HOME/.config/$rel"
  if [[ -L "$directory" && $(readlink -f "$directory") == "$root/home/.config/$rel" ]]; then
    replacement=$(mktemp -d "${directory}.unfold.XXXXXX")
    cp -a "$directory/." "$replacement/"
    unlink "$directory"
    mv "$replacement" "$directory"
  fi
done

link_file() {
  local source=$1 target=$2
  mkdir -p "$(dirname -- "$target")"
  if [[ $(readlink -f -- "$target" 2>/dev/null || true) == "$source" ]]; then
    return
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    mv -- "$target" "$target.backup.$(date +%s%N)"
  fi
  ln -s -- "$source" "$target"
}

case "$mode" in
  --remote)
    if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
      systemctl --user disable --now workstation-tunnel.service url-open.socket url-open.service url-open-reader.service 2>/dev/null || true
    fi
    rm -f "$HOME/.config/systemd/user/default.target.wants/workstation-tunnel.service" \
      "$HOME/.config/systemd/user/sockets.target.wants/url-open.socket" \
      "$HOME/.config/systemd/user/graphical-session.target.wants/url-open-reader.service"
    for file in .scripts/url-open .config/shell/browser.sh .bashrc .bash_profile .zprofile .zshrc .zshenv; do
      link_file "$root/home/$file" "$HOME/$file"
    done
    link_file "$root/home/.scripts/url-open" "$HOME/.local/bin/url-open"
    link_file "$root/home/.scripts/url-open" "$HOME/.local/bin/xdg-open"
    # Explicit settings also cover processes started before the shell update.
    if command -v gh >/dev/null; then
      gh config set browser "$HOME/.scripts/url-open"
    fi
    git config --global gitsign.urlOpener "$HOME/.scripts/url-open {{.URL}}"
    bash "$root/bin/install-gitsign-fork" --system
    echo 'Workstation signing and browser relay installed. Reopen existing shells to load the browser environment.'
    ;;
  --local)
    command -v python3 >/dev/null
    command -v xdg-open >/dev/null
    systemctl --user show-environment >/dev/null
    for file in .scripts/url-dispatch .scripts/workstation-ssh-proxy .ssh/config.d/workstation; do
      link_file "$root/home/$file" "$HOME/$file"
    done
    python3 - <<'PY'
import os
from pathlib import Path
import re
import time

config = Path.home() / '.ssh/config'
old = config.read_text() if config.exists() else ''
include = 'Include ~/.ssh/config.d/workstation'
lines = []
skip = False
for line in old.splitlines():
    match = re.match(r'^\s*(Host|Match)\s+(.+)', line, re.I)
    if match:
        patterns = match[2].split()
        managed = {'workstation', 'workstation-tunnel'}
        if match[1].lower() == 'host' and managed.intersection(patterns):
            if not set(patterns) <= managed:
                raise SystemExit('Split workstation aliases into their own Host block before installing.')
            skip = True
        else:
            skip = False
    if not skip and line.strip() != include:
        lines.append(line)
new = include + '\n' + '\n'.join(lines).lstrip('\n')
if not new.endswith('\n'):
    new += '\n'
if new != old:
    if config.exists():
        backup = config.with_name(f'config.backup.{time.time_ns()}')
        backup.write_text(old)
        backup.chmod(0o600)
    config.write_text(new)
    config.chmod(0o600)
PY
    systemctl --user disable --now url-open-reader.service 2>/dev/null || true
    systemctl --user stop url-open.service url-open.socket 2>/dev/null || true
    for unit in url-open.socket url-open.service workstation-tunnel.service; do
      link_file "$root/home/.config/systemd/user/$unit" "$HOME/.config/systemd/user/$unit"
    done
    systemctl --user daemon-reload
    systemctl --user enable --now url-open.socket
    systemctl --user enable workstation-tunnel.service
    systemctl --user restart workstation-tunnel.service
    echo 'Local browser relay installed; workstation-tunnel.service connects in the background.'
    ;;
  *)
    echo 'Usage: workstation.sh [--auto|--local|--remote]' >&2
    exit 2
    ;;
esac
