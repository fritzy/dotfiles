#!/bin/bash

# Purpose: Install and boostrap neovim on Mac and Codespaces.
# It could be extended for more than neovim, but this is my primary need.
#
# Due to the usage of "stow", we assume that the path is $HOME/dotfiles.
#
# NOTE: This script could easily break if neovim changes their release conventions.

machine_os=$(uname)
machine_arch=$(uname -m)
nvim_config=$HOME/.config/nvim
nvim_bin=$HOME/.local/bin/nvim

OPTS=$(getopt -o a --long appimage -n 'bootstrap.sh' -- "$@")

if [ $? -ne 0 ]; then
  echo "Failed to parse options" >&2
  exit 1
fi

## Reset the positional parameters to the parsed options
eval set -- "$OPTS"

appimage=false

## Process the options
while true; do
  case "$1" in
    -a | --appimage)
      appimage=true
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

nvim_file_part="nvim-$machine_os-$machine_arch"

# We primarily are supporting
#
# - nvim-macos-x86_64.tar.gz (I still have one)
# - nvim-macos-arm64.tar.gz
# - nvim-linu-x86_64.tar.gz (codespaces, etc)
# - appimage variants when flag present
#
# other architectures may or may not work in the future

# maybe an old version has already been pulled and we're just upgrading
rm -f *.tar.gz
rm -f *.appimage
rm -rf $HOME/.local/opt/$nvim_file_part

# ensuring we have target directories
mkdir -p $HOME/.local/opt
mkdir -p $HOME/.local/bin
mkdir -p $nvim_config

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
    else
      echo "none"
    fi
  else
    echo "none"
  fi
}

# Detect the package manager

have_stow=$(command -v stow >/dev/null 2>&1 && echo true || echo false)
echo "Stow installed: $have_stow"

# Install stow based on the detected package manager
if [ "$have_stow" != "true" ]; then
  package_manager=$(detect_package_manager)
  if [[ $package_manager == "brew" ]]; then
    echo "Checking for stow in brew"
    (brew list stow || brew install stow) > /dev/null
    have_stow=true
  elif [[ $package_manager == "apt-get" ]]; then
    echo "Installing stow using apt-get"
    sudo apt update
    sudo apt install -y stow
    have_stow=true
  elif [[ $package_manager == "pacman" ]]; then
    echo "Installing stow using pacman"
    sudo pacman -Sy --noconfirm stow
    have_stow=true
  else
    echo "No supported package manager found. Manual installation required."
    echo "Forcing replacement of $nvim_config ..."
    rm -rf $nvim_config
    cp -R ./home/.config/nvim/* $nvim_config/
  fi
fi

if [[ $have_stow = true ]]; then
  echo
  echo "Syncing home config..."
  stow -v -t ~ home
fi

nvim_full_file=$nvim_file_part.tar.gz
if [[ $appimage == "true" ]]; then
  nvim_full_file=$nvim_file_part.appimage
fi

echo
echo "Downloading latest neovim...$nvim_full_file"
curl -LO https://github.com/neovim/neovim/releases/latest/download/$nvim_full_file
if [ $? -eq 0 ]; then
  echo "Success, installing..."
  rm -f $nvim_bin
  if [[ $appimage == "true" ]]; then
    cp $nvim_full_file $HOME/.local/opt/$nvim_file_part
    ln -s $HOME/.local/opt/$nvim_file_part $nvim_bin
    chmod +x $HOME/.local/opt/$nvim_file_part
  else
    tar -C $HOME/.local/opt -xzf $nvim_file_part.tar.gz
    ln -s $HOME/.local/opt/$nvim_file_part/bin/nvim $nvim_bin
  fi
  echo "Bootstrapping neovim config... (may take some time)"
  # install Lazy plugins
  $nvim_bin --headless "+Lazy! sync" +qa > /dev/null
  # setup lanuage servers
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
  echo "Done bootstrapping neovim (nvim)."
  echo
  echo "Installed at:"
  echo "$HOME/.local/opt/$nvim_file_part ->"
  echo "$nvim_bin"
  echo
else
  echo "Failed to download neovim, aborting."
  exit 1
fi
