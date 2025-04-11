#!/bin/bash

# Purpose: Install and boostrap neovim on Mac and Codespaces.
# It could be extended for more than neovim, but this is my primary need.
#
# Due to the usage of "stow", we assume that the path is $HOME/dotfiles.
#
# NOTE: This script could easily break if neovim changes their release conventions.

machine_os=$(uname)
machine_arch=$(uname -m)

if [ "$machine_os" == "Darwin" ]; then
  machine_os="macos"
elif [[ $machine_os == "Linux" ]]; then
  machine_os="linux"
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
#
# other architectures may or may not work in the future

# maybe an old version has already been pulled and we're just upgrading
rm -f *.tar.gz
rm -rf $HOME/.local/opt/$nvim_file_part

# ensuring we have target directories
mkdir -p $HOME/.local/opt
mkdir -p $HOME/.local/bin
mkdir -p $HOME/.config/nvim

have_stow=false

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
package_manager=$(detect_package_manager)

# Install stow based on the detected package manager
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
  echo "Forcing replacement of $HOME/.config/nvim ..."
  rm -rf $HOME/.config/nvim
  cp -R ./home/.config/nvim/* $HOME/.config/nvim/
fi

if [[ $have_stow = true ]]; then
  echo
  echo "Syncing home config..."
  stow -v -t ~ home
fi

echo
echo "Downloading latest neovim...$nvim_file_part.tar.gz"
curl -LO https://github.com/neovim/neovim/releases/latest/download/$nvim_file_part.tar.gz
if [ $? -eq 0 ]; then
  echo "Success, installing..."
  rm -f $HOME/.local/bin/nvim
  tar -C $HOME/.local/opt -xzf $nvim_file_part.tar.gz
  ln -s $HOME/.local/opt/$nvim_file_part/bin/nvim $HOME/.local/bin/nvim
  echo "Bootstrapping neovim config... (may take some time)"
  # install Lazy plugins
  nvim --headless "+Lazy! sync" +qa > /dev/null
  # setup lanuage servers
  nvim --headless "+MasonInstall typescript-language-server eslint-lsp" +qa > /dev/null 2> /dev/null

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
  echo "$HOME/.local/bin/nvim"
  echo
else
  echo "Failed to download neovim, aborting."
  exit 1
fi
