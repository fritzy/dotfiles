#!/bin/bash

# Purpose: Install and bootstrap dotfiles, neovim, and supporting tools.
#
# Shared setup; work roles have separate bootstrap scripts.

set -e

machine_os=$(uname)
machine_arch=$(uname -m)
dotfiles_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
nvim_config=$HOME/.config/nvim
nvim_bin=$HOME/.local/bin/nvim
eget_bin=$HOME/.local/bin/eget

# Packages to install via the system package manager
packages=(python3 stow fzf zsh-autosuggestions nc zellij)

# Maps "command:package_manager" -> actual package name, for commands whose
# package name differs from the command itself.
declare -A pkg_names=(
  [python3:brew]="python"
  [nc:brew]="netcat"
  [nc:apt-get]="netcat-openbsd"
  [nc:pacman]="openbsd-netcat"
  [nc:coldbrew]="netcat-openbsd"
  [nc:nix-env]="netcat"
)

pkg_long_opts=$(printf "no-%s," "${packages[@]}")
OPTS=$(getopt -o a --long "appimage,no-nvim,${pkg_long_opts%,}" -n 'bootstrap.sh' -- "$@")

if [ $? -ne 0 ]; then
  echo "Failed to parse options" >&2
  exit 1
fi

## Reset the positional parameters to the parsed options
eval set -- "$OPTS"

appimage=false
install_nvim=true
skip_packages=()

## Process the options
while true; do
  case "$1" in
    -a | --appimage)
      appimage=true
      shift
      ;;
    --no-nvim)
      install_nvim=false
      shift
      ;;
    --no-*)
      skip_packages+=("${1#--no-}")
      shift
      ;;
    --)
      shift
      break
      ;;
  esac
done

if [ "$machine_os" == "Darwin" ]; then
  machine_os="macos"
elif [[ $machine_os == "Linux" ]]; then
  machine_os="linux"
fi
if [[ $machine_arch == "aarch64" ]]; then
  machine_arch="arm64"
fi

echo "Bootstrapping ... $machine_os :: $machine_arch"

shell_file="$HOME/.bashrc"
if [[ $SHELL == "/bin/zsh" ]]; then
  shell_file="$HOME/.zshrc"
fi

# ensuring we have target directories
mkdir -p $HOME/.local/opt
mkdir -p $HOME/.local/bin
export PATH="$HOME/.local/bin:$PATH"
mkdir -p $HOME/.local/brew
mkdir -p $nvim_config

# Provide a wget shim backed by curl when wget is absent (e.g. coldbrew needs it)
if ! command -v wget &>/dev/null && command -v curl &>/dev/null; then
  cat > "$HOME/.local/bin/wget" << 'WGET_SHIM'
#!/bin/bash
# curl-based wget compatibility shim
curl_args=("-L")
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -q|--quiet) curl_args+=("-s") ;;
    -O-)        output="-" ;;
    -O)         shift; output="$1" ;;
    -O*)        output="${1#-O}" ;;
    http*|ftp*) url="$1" ;;
    *) ;;
  esac
  shift
done
if [[ -n "$output" && "$output" != "-" ]]; then
  exec curl "${curl_args[@]}" -o "$output" "$url"
else
  exec curl "${curl_args[@]}" "$url"
fi
WGET_SHIM
  chmod +x "$HOME/.local/bin/wget"
  export PATH="$HOME/.local/bin:$PATH"
fi

# Bootstrap Homebrew to $HOME/.local/brew on macOS if not already present
if [[ $machine_os == "macos" ]] && ! command -v brew &> /dev/null; then
  echo "Bootstrapping Homebrew to $HOME/.local/brew..."
  git clone https://github.com/Homebrew/brew "$HOME/.local/brew"
  eval "$($HOME/.local/brew/bin/brew shellenv)"
  brew update --force --quiet

  profile_line='eval "$($HOME/.local/brew/bin/brew shellenv)"'
  if ! grep -qF "$profile_line" "$HOME/.zprofile" 2>/dev/null; then
    echo "" >> "$HOME/.zprofile"
    echo "# Homebrew (local)" >> "$HOME/.zprofile"
    echo "$profile_line" >> "$HOME/.zprofile"
  fi
fi

# On Alpine-based systems, bootstrap coldbrew (rootless, aports-backed) instead
# of using apk directly. Requires bubblewrap to be present on the host.
if [[ $machine_os == "linux" ]] && command -v apk &> /dev/null && ! command -v coldbrew &> /dev/null; then
  echo "Bootstrapping coldbrew to $HOME/.local/opt/coldbrew..."
  if ! command -v bwrap &> /dev/null; then
    echo "Warning: bubblewrap (bwrap) not found on host — coldbrew requires it to run packages." >&2
  fi
  if [[ ! -d $HOME/.local/opt/coldbrew ]]; then
    git clone https://gitlab.postmarketos.org/postmarketOS/coldbrew "$HOME/.local/opt/coldbrew"
  fi
  ln -sf "$HOME/.local/opt/coldbrew/coldbrew" "$HOME/.local/bin/coldbrew"
  export PATH="$HOME/.local/bin:$PATH"
fi

# Function to detect the default package manager
detect_package_manager() {
  if [[ $machine_os == "macos" ]]; then
    if command -v brew &> /dev/null; then
      echo "brew"
    else
      echo "none"
    fi
  elif [[ $machine_os == "linux" ]]; then
    if command -v apt-get &> /dev/null; then
      echo "apt-get"
    elif command -v pacman &> /dev/null; then
      echo "pacman"
    elif command -v apk &> /dev/null; then
      # Alpine detected, but we use coldbrew rather than apk directly.
      if command -v coldbrew &> /dev/null || [[ -x $HOME/.local/bin/coldbrew ]]; then
        echo "coldbrew"
      else
        echo "none"
      fi
    elif command -v nix-env &> /dev/null; then
      echo "nix-env"
    else
      echo "none"
    fi
  else
    echo "none"
  fi
}

# Return 0 if the package is already present on the system.
# Most packages ship a binary of the same name; a few (shell plugins) don't,
# so we check known file locations as a fallback.
package_present() {
  local pkg=$1
  command -v "$pkg" &> /dev/null && return 0
  case $pkg in
    zsh-autosuggestions)
      local candidates=(
        /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh
        /usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh
        /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh
        /usr/local/share/zsh-autosuggestions/zsh-autosuggestions.zsh
        "$HOME/.local/opt/coldbrew/prefix/usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
      )
      local f
      for f in "${candidates[@]}"; do
        [[ -f $f ]] && return 0
      done
      return 1
      ;;
  esac
  return 1
}

install_package() {
  local pkg=$1
  local pm=$(detect_package_manager)
  local actual_pkg="${pkg_names[$pkg:$pm]:-$pkg}"
  echo "Installing $pkg via $pm..."
  case $pm in
    brew)    brew install "$actual_pkg" ;;
    apt-get) sudo apt-get install -y "$actual_pkg" ;;
    pacman)  sudo pacman -Sy --needed --noconfirm "$actual_pkg" ;;
    coldbrew)
      coldbrew install "$actual_pkg"
      coldbrew wrap "$pkg" 2>/dev/null || true
      ;;
    nix-env) nix-env -iA "nixpkgs.$actual_pkg" ;;
    *)       echo "No supported package manager found, skipping $pkg." ;;
  esac
}

echo
echo "Checking packages: ${packages[*]}"
to_install=()
for pkg in "${packages[@]}"; do
  if [[ " ${skip_packages[*]} " == *" $pkg "* ]]; then
    echo "Skipping $pkg (--no-$pkg)."
    continue
  fi
  if package_present "$pkg"; then
    echo "$pkg already installed, skipping."
    continue
  fi
  to_install+=("$pkg")
done

if (( ${#to_install[@]} > 0 )); then
  pm=$(detect_package_manager)
  if [[ $pm == "apt-get" ]]; then
    sudo apt-get update -qq
  fi
  for pkg in "${to_install[@]}"; do
    install_package "$pkg"
  done
fi

if ! python3 "$dotfiles_root/bin/sync-dotfiles" home; then
  echo "Dotfile setup failed; fix the error above and rerun bootstrap.sh." >&2
  exit 1
fi

# Claude and Codex keep credentials, transcripts, databases, and other runtime
# state beside their settings. Keep those directories real and copy only the
# intentional config stored outside the Stow package.
sync_ai_file() {
  local source_file=$1
  local target_file=$2
  local mode=$3

  [[ -f $source_file ]] || return 0
  mkdir -p "$(dirname "$target_file")"
  [[ -L $target_file ]] && unlink "$target_file"
  install -m "$mode" "$source_file" "$target_file"
}

seed_config_file() {
  if [[ -L $2 && ! -e $2 ]]; then
    echo "Broken configuration link: $2; restore its target before rerunning bootstrap." >&2
    return 1
  fi
  [[ ! -e $2 && ! -L $2 ]] || return 0
  sync_ai_file "$@"
}

echo
echo "Syncing Claude and Codex config..."
codex_dir=${CODEX_HOME:-$HOME/.codex}
claude_dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
sync_ai_file "$dotfiles_root/claude/CLAUDE.md" "$claude_dir/CLAUDE.md" 644
seed_config_file "$dotfiles_root/claude/settings.json" "$claude_dir/settings.json" 600
seed_config_file "$dotfiles_root/claude/plugins/known_marketplaces.json" "$claude_dir/plugins/known_marketplaces.json" 600
sync_ai_file "$dotfiles_root/codex/AGENTS.md" "$codex_dir/AGENTS.md" 644
seed_config_file "$dotfiles_root/codex/config.toml" "$codex_dir/config.toml" 600
python3 "$dotfiles_root/bin/sync-ai-skills" "$dotfiles_root/claude/skills" "$claude_dir/skills"
python3 "$dotfiles_root/bin/sync-ai-skills" "$dotfiles_root/codex/skills" "$codex_dir/skills"
seed_config_file "$dotfiles_root/home/.config/fritzworks/config.ini" "${XDG_CONFIG_HOME:-$HOME/.config}/fritzworks/config.ini" 600

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  if ! bash "$dotfiles_root/bin/setup-codex"; then
    echo "Codex setup failed; fix the error above and rerun bin/setup-codex." >&2
    exit 1
  fi
  if ! command -v codex >/dev/null 2>&1; then
    export PATH="$(npm config get prefix)/bin:$PATH"
  fi
else
  echo "Skipping Codex: install Node.js and npm, then rerun bootstrap."
fi

# FritzWorks owns its installation and integration lifecycle.
echo
if command -v fw >/dev/null 2>&1; then
  if ! fw --version >/dev/null 2>&1; then
    echo "Existing FritzWorks command failed; repair it explicitly with bin/install-fritzworks --desktop." >&2
    exit 1
  fi
  python3 "$dotfiles_root/bin/setup-fritzworks"
elif ! bash "$dotfiles_root/bin/install-fritzworks" --desktop; then
  echo "FritzWorks installation failed; fix the error above and rerun bin/install-fritzworks --desktop." >&2
  exit 1
fi

# Install eget (used to install GitHub release binaries)
if ! command -v eget &> /dev/null && [[ ! -f $eget_bin ]]; then
  echo
  echo "Installing eget..."
  curl -o eget.sh https://zyedidia.github.io/eget.sh
  sh eget.sh
  mv eget $eget_bin
  rm -f eget.sh
fi

# Install starship prompt (referenced in .zshrc)
if ! command -v starship &> /dev/null && [[ ! -f $HOME/.local/bin/starship ]]; then
  echo
  echo "Installing starship..."
  if ldd /bin/sh 2>/dev/null | grep -q musl; then
    starship_libc="musl"
  else
    starship_libc="gnu"
  fi
  $eget_bin starship/starship --to $HOME/.local/bin --asset "${machine_arch}-unknown-linux-${starship_libc}"
fi

have_sufficient_system_nvim() {
  local sys_nvim=/usr/bin/nvim
  [[ -x $sys_nvim ]] || return 1
  local ver
  ver=$("$sys_nvim" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1) || return 1
  local major=${ver%.*} minor=${ver#*.}
  (( major > 0 )) && return 0
  (( minor >= 12 )) && return 0
  return 1
}

if [[ $install_nvim == "true" ]] && have_sufficient_system_nvim; then
  echo "System neovim at /usr/bin/nvim is >= 0.12, skipping install."
  nvim_bin=/usr/bin/nvim
elif [[ $install_nvim == "true" ]]; then
  echo
  echo "Installing neovim..."
  pm=$(detect_package_manager)
  if [[ $pm == "pacman" ]]; then
    sudo pacman -Sy --needed --noconfirm neovim
  elif [[ $pm == "coldbrew" ]]; then
    coldbrew install neovim
    coldbrew wrap nvim 2>/dev/null || true
  elif [[ $pm == "nix-env" ]]; then
    nix-env -iA nixpkgs.neovim
  elif [[ $appimage == "true" ]]; then
    $eget_bin neovim/neovim --to $HOME/.local/bin --asset appimage
  else
    $eget_bin neovim/neovim --to $HOME/.local/bin
  fi
fi

if [[ $install_nvim == "true" ]]; then
  if [[ -x $nvim_bin ]]; then
    echo "Bootstrapping neovim config... (may take some time)"
    # install vim.pack plugins (force skips confirmation prompts)
    $nvim_bin --headless -c "lua vim.pack.update(nil, {force=true})" -c "qa" > /dev/null

    if ! grep -q "export PATH=\$HOME/.local/bin:\$PATH" $HOME/.profile; then
      echo "Adding path to $HOME/.profile"
      echo "" >> $HOME/.profile
      echo "# add dot-local path" >> $HOME/.profile
      echo "export PATH=\$HOME/.local/bin:\$PATH" >> $HOME/.profile
    fi

    if [[ -z $(grep "alias vi=\"nvim\"" $shell_file) ]]; then
      echo "Adding alias to $shell_file"
      echo "" >> $shell_file
      echo -e "alias vi=\"nvim\"" >> $shell_file
      echo -e "alias vim=\"nvim\"" >> $shell_file
    fi
    echo "Done bootstrapping neovim (nvim) at $nvim_bin"
  else
    echo "Failed to install neovim, aborting."
    exit 1
  fi
else
  echo "Skipping neovim installation (--no-nvim)."
fi
