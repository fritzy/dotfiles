#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export PATH="$HOME/.local/bin:$PATH"

[[ $# -eq 0 ]] || { echo 'Usage: bootstrap-workstation.sh' >&2; exit 2; }
[[ $(uname) == Linux ]] || { echo 'Cloud workstation setup requires Linux.' >&2; exit 1; }
python3 "$root/bin/sync-dotfiles" workstation
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now workstation-tunnel.service url-open.socket url-open.service url-open-reader.service 2>/dev/null || true
fi
rm -f "$HOME/.config/systemd/user/default.target.wants/workstation-tunnel.service" \
  "$HOME/.config/systemd/user/sockets.target.wants/url-open.socket" \
  "$HOME/.config/systemd/user/graphical-session.target.wants/url-open-reader.service"
if command -v gh >/dev/null; then
  gh config set browser "$HOME/.scripts/url-open"
fi
git config --global gitsign.urlOpener "$HOME/.scripts/url-open {{.URL}}"
bash "$root/bin/install-gitsign-fork" --system
bash "$root/bin/setup-work-tools"
echo 'Cloud workstation configured. Reopen shells to load the browser environment.'
