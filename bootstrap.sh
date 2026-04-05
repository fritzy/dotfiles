#!/bin/bash

# Purpose: Install and bootstrap dotfiles, neovim, and supporting tools.
#
# Due to the usage of "stow", we assume that the path is $HOME/dotfiles.

machine_os=$(uname)
machine_arch=$(uname -m)
nvim_config=$HOME/.config/nvim
nvim_bin=$HOME/.local/bin/nvim
eget_bin=$HOME/.local/bin/eget

# Packages to install via the system package manager
packages=(stow fzf zsh-autosuggestions)

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
mkdir -p $HOME/.local/brew
mkdir -p $nvim_config

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
      echo "apk"
    elif command -v nix-env &> /dev/null; then
      echo "nix-env"
    else
      echo "none"
    fi
  else
    echo "none"
  fi
}

# Install a package if not already present
install_package() {
  local pkg=$1
  if command -v "$pkg" &> /dev/null; then
    echo "$pkg already installed, skipping."
    return
  fi
  local pm=$(detect_package_manager)
  echo "Installing $pkg via $pm..."
  case $pm in
    brew)    brew install "$pkg" ;;
    apt-get) sudo apt-get install -y "$pkg" ;;
    pacman)  sudo pacman -Sy --needed --noconfirm "$pkg" ;;
    apk)     sudo apk add "$pkg" ;;
    nix-env) nix-env -iA "nixpkgs.$pkg" ;;
    *)       echo "No supported package manager found, skipping $pkg." ;;
  esac
}

echo
echo "Installing packages: ${packages[*]}"
pm_updated=false
for pkg in "${packages[@]}"; do
  if [[ " ${skip_packages[*]} " == *" $pkg "* ]]; then
    echo "Skipping $pkg (--no-$pkg)."
    continue
  fi
  if [[ $(detect_package_manager) =~ ^(apt-get|apk)$ && $pm_updated == false ]]; then
    sudo $(detect_package_manager) update -qq
    pm_updated=true
  fi
  install_package "$pkg"
done

have_stow=$(command -v stow >/dev/null 2>&1 && echo true || echo false)
if [[ $have_stow = true ]]; then
  echo
  echo "Syncing home config..."
  stow -v -t ~ home
else
  echo "stow not available. Forcing replacement of $nvim_config ..."
  rm -rf $nvim_config
  cp -R ./home/.config/nvim/* $nvim_config/
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

if [[ $install_nvim == "true" ]]; then
  echo
  echo "Installing neovim..."
  pm=$(detect_package_manager)
  if [[ $pm == "pacman" ]]; then
    sudo pacman -Sy --needed --noconfirm neovim
  elif [[ $pm == "apk" ]]; then
    sudo apk add neovim
  elif [[ $pm == "nix-env" ]]; then
    nix-env -iA nixpkgs.neovim
  elif [[ $appimage == "true" ]]; then
    $eget_bin neovim/neovim --to $HOME/.local/bin --asset appimage
  else
    $eget_bin neovim/neovim --to $HOME/.local/bin
  fi

  if [[ -f $nvim_bin ]]; then
    echo "Bootstrapping neovim config... (may take some time)"
    # install Lazy plugins
    $nvim_bin --headless "+Lazy! sync" +qa > /dev/null
    # setup language servers
    $nvim_bin --headless "+MasonInstall typescript-language-server eslint-lsp" +qa > /dev/null 2> /dev/null

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
