#!/bin/bash

machine_os=$(uname)
machine_arch=$(uname -m)

if [ "$machine_os" == "Darwin" ]; then
  machine_os="macos"
fi

echo "Bootstrapping ... $machine_os :: $machine_arch"

shell_file="$HOME/.bashrc"
if [[ $SHELL == "/bin/zsh" ]]; then
  shell_file="$HOME/.zshrc"
fi

nvim_file_part="nvim-$machine_os-$machine_arch"
if [ "$machine_os" == "Linux" ]; then
  # there aren't any linux arm64 builds yet
  # and the naming doesn't follow convention
  nvim_file_part="nvim-linux64"
fi

# maybe an old version has already been pulled and we're just upgrading
rm $nvim_file_part.tar.gz
rm -rf $HOME/.local/opt/$nvim_file_part

# ensuring we have target directories
mkdir -p $HOME/.local/opt
mkdir -p $HOME/.local/bin
mkdir -p $HOME/.config/nvim

# we could check for $CODESPACES somewhere in here
# and do logic for that
# if [ "$CODESPACES" == "true" ]; then
#   echo "Doing something cool with codespaces"
# fi

if [ "machine_os" == "macos" ]; then
  echo "Checking for stow in brew"
  # if stow isn't installed, install it
  brew list stow || brew install stow
  stow --adopt .
elif [ "machine_os" == "Linux" ]; then
  if [[ ! -z $(which apt-get) ]]; then
    echo "Installing stow and applying dotfiles"
    sudo apt update
    sudo apt install -y stow
    stow --adopt .
  else
    echo "No brew nor apt, so we're replacing $HOME/.config/nvim"
    # no gods or kings, only man
    rm -rf $HOME/.config/nvim
    cp -R ./.config/nvim/* $HOME/.config/nvim/
  fi
fi

echo "Downloading latest neovim...$nvim_file_part.tar.gz"
curl -LO https://github.com/neovim/neovim/releases/latest/download/$nvim_file_part.tar.gz
if [ $? -eq 0 ]; then
  echo "Success, installing..."
  rm $HOME/.local/bin/nvim
  tar -C $HOME/.local/opt -xzf $nvim_file_part.tar.gz
  ln -s $HOME/.local/opt/$nvim_file_part/bin/nvim $HOME/.local/bin/nvim
  echo "Bootstrapping neovim config..."
  # install Lazy plugins
  nvim --headless "+Lazy! sync" +qa
  # setup lanuage servers
  nvim --headless "+MasonInstall typescript-language-server eslint-lsp" +qa

  if [[ $PATH != *"$HOME/.local/bin"* ]]; then
    echo "" >> $HOME/.profile
    echo "# add dot-local path" >> $HOME/.profile
    echo "export PATH=\$HOME/.local/bin:\$PATH" >> $HOME/.profile
  fi
  if [[ $(alias) != *"vi=\"nvim\""* ]]; then
    echo "" >> $shell_file
    echo "alias vi=\"nvim\"" >> $shell_file
  fi
else
  echo "Failed to download neovim, aborting."
fi
