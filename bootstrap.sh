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
  rm $HOME/.local/bin/nvim
  ln -s $HOME/.local/opt/nvim-linux64/bin/nvim $HOME/.local/bin/nvim
  rm -rf $HOME/.config/nvim
  mkdir -p $HOME/.config/nvim
  cp -R ./.config/nvim/* $HOME/.config/nvim/
  nvim --headless "+Lazy! sync" +qa
  nvim --headless "+MasonInstall typescript-language-server eslint-lsp" +qa
else
  echo "Not a Codespace, skipping neovim install."
fi
