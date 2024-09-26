#!/bin/bash

if [ "$CODESPACES" == "true" ]
then
  echo "installing neovim"
  curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz
  sudo tar -C $HOME/opt -xzf nvim-linux64.tar.gz
  ln -s $HOME/opt/nvim-linux64/bin/nvim $HOME/bin/nvim
else
  echo -e "Not a Codspace, skipping neovim install."
fi
