# @fritzy dotfiles

This is a [stow](https://www.gnu.org/software/stow/) based dotfiles repo with bootstrap script with multiple OSes and Architectures supported.

## Features:

- Installs the latest `neovim` in `~/.local`
- Installs `stow` via `apt` or `brew`
- Installs the latest `kitty.app` on macos
- Supports Linux & MacOS on Arm and x86
- Adds aliases/env to `.bashrc` or `.zshrc`
- Uses a guarded interactive Bash-to-Zsh handoff, so a persistent home can keep
  Zsh as the user shell when an ephemeral host resets its passwd entry to Bash
- Syncs dotfiles with `stow` (primarily `~/.config/nvim/...`)
- Copies allowlisted Claude and Codex settings and skills without linking their runtime directories into this repo
- Links the shell startup files directly when `stow` is temporarily unavailable
- Bootstraps NeoVim Lazy plugins

## About

I use this primarily to keep my dev environment current on my local MacOS and my GitHub Codespaces VMs.

## Notes

- If neovim or kitty reformats their release file structure, it'll need fixing
- You'll need to enable dotfiles for GH Codespaces
- The GH Codespaces path is an implementation detail
  - Currently something like `/workspaces/.codespaces/.persistedshare/dotfiles`
