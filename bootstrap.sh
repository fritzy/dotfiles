#!/bin/bash

if [ "$CODESPACES" == "true" ]
then
  echo "Installing neovim..."
  if [ ! -f nvim-linux64.tar.gz ]; then
    curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz
  else
    echo "Already downloaded tgz"
  fi
  mkdir -p $HOME/.local/opt
  tar -C $HOME/.local/opt -xzf nvim-linux64.tar.gz
  ln -s $HOME/.local/opt/nvim-linux64/bin/nvim $HOME/.local/bin/nvim
else
  echo "Not a Codespace, skipping neovim install."
fi
