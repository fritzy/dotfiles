#!/bin/bash
set -euo pipefail

package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
(cd "$package_dir" && npm ci --ignore-scripts --no-audit --no-fund)
exec node "$package_dir/setup.js" "$@"
