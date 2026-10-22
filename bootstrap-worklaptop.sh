#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export PATH="$HOME/.local/bin:$PATH"

[[ $# -eq 0 ]] || { echo 'Usage: bootstrap-worklaptop.sh' >&2; exit 2; }
command -v python3 >/dev/null
command -v ssh >/dev/null
command -v xdg-open >/dev/null
systemctl --user show-environment >/dev/null

python3 "$root/bin/sync-dotfiles" worklaptop
python3 - <<'PY'
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
systemctl --user daemon-reload
systemctl --user enable --now url-open.socket
systemctl --user enable workstation-tunnel.service
systemctl --user restart workstation-tunnel.service
bash "$root/bin/setup-work-tools"
echo 'Work laptop configured; workstation-tunnel.service connects in the background.'
