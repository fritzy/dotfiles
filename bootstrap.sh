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

# We could have special cases for $CODESPACES in the future.
# For now, it's not necessary.
#
# Setup:
#  - Enable dotfiles for codespaces
#  - The path will be something like /workspaces/.codespaces/.persistedshare/dotfiles
#
# if [ "$CODESPACES" == "true" ]; then
#   echo "Doing something cool with codespaces"
# fi

if [[ $machine_os == "macos" ]]; then
  echo "Checking for stow in brew"
  # if stow isn't installed, install it
  (brew list stow || brew install stow) > /dev/null
  have_stow=true
  echo
  echo "Syncing macos apps"
  stow -t ~ macos
  echo
  echo "Updating kitty tty..."
  update-kitty
elif [[ $machine_os == "Linux" ]]; then
  if [[ ! -z $(which apt-get) ]]; then
    echo "Installing stow and applying dotfiles"
    sudo apt update
    sudo apt install -y stow
    stow -t ~ home
    have_stow=true
    machine_os="linux"
  else
    echo "No brew nor apt, so we can't install stow."
    echo "Forcing replacement of $HOME/.config/nvim ..."
    # no gods or kings, only man
    rm -rf $HOME/.config/nvim
    cp -R ./home/.config/nvim/* $HOME/.config/nvim/
  fi
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
  rm $HOME/.local/bin/nvim
  tar -C $HOME/.local/opt -xzf $nvim_file_part.tar.gz
  ln -s $HOME/.local/opt/$nvim_file_part/bin/nvim $HOME/.local/bin/nvim
  echo "Bootstrapping neovim config... (may take some time)"
  # install Lazy plugins
  nvim --headless "+Lazy! sync" +qa > /dev/null
  # setup lanuage servers
  nvim --headless "+MasonInstall typescript-language-server eslint-lsp" +qa > /dev/null 2> /dev/null

  if [[ $PATH != *"$HOME/.local/bin"* ]]; then
    echo "Adding path to $HOME/.profile"
    echo "" >> $HOME/.profile
    echo "# add dot-local path" >> $HOME/.profile
    echo -e "export PATH=\$HOME/.local/bin:\$PATH" >> $HOME/.profile
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
fi
