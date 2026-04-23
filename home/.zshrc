source ~/.zprofile
# Lines configured by zsh-newuser-install
HISTFILE=~/.histfile
HISTSIZE=1000
SAVEHIST=10000
setopt autocd extendedglob interactivecomments
unsetopt beep nomatch
bindkey -v
# End of lines configured by zsh-newuser-install
# The following lines were added by compinstall
zstyle :compinstall filename '/home/nathan.fritz/.zshrc'
bindkey "^R" history-incremental-search-backward

autoload -Uz compinit
compinit -d ~/.zcompdump

# interactive completion menu (arrow key navigation)
zstyle ':completion:*' menu select
# End of lines added by compinstall
eval "$(starship init zsh)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

alias vi="nvim"
alias vim="nvim"

ghcd() {
  if [[ "$1" == "add" ]]; then
    command ghcd "$@"
  else
    local target
    target="$(command ghcd "$@")" && cd "$target"
  fi
}

_ghcd() {
  local config="${XDG_CONFIG_HOME:-$HOME/.config}/ghcd.ini"
  local default_base="$HOME/github"
  local cur="${words[CURRENT]}"

  # 'add' subcommand: complete the directory argument
  if [[ "${words[2]}" == "add" && $CURRENT -eq 3 ]]; then
    _directories
    return
  fi

  # Collect configured repos (with mapped path as description)
  local -a repo_names repo_descs
  if [[ -f "$config" ]]; then
    local in_dirs=0
    while IFS= read -r line; do
      [[ "$line" == '[directories]' ]] && in_dirs=1 && continue
      [[ "$line" =~ ^\[.*\]$ ]] && in_dirs=0 && continue
      if (( in_dirs )) && [[ "$line" =~ '^([^ ]+) = (.+)$' ]]; then
        repo_names+=("${match[1]}")
        repo_descs+=("${match[1]}:${match[2]}")
      fi
    done < "$config"
  fi

  # Also collect repos from the default base dir (if not already in config)
  if [[ -d "$default_base" ]]; then
    for d in "$default_base"/*/*(/N); do
      local rel="${d#$default_base/}"
      [[ "${repo_names[(r)$rel]}" != "$rel" ]] && repo_names+=("$rel")
    done
  fi

  # If the current word has two path components (user/repo/...), complete worktrees
  if [[ "$cur" =~ '^([^/]+/[^/]+)/' ]]; then
    local user_repo="${match[1]}"
    local repo_dir

    [[ -f "$config" ]] && repo_dir=$(awk -F' = ' -v k="$user_repo" '
      /^\[directories\]/{s=1;next} /^\[/{s=0}
      s && $1==k{print $2; exit}
    ' "$config")
    [[ -z "$repo_dir" ]] && repo_dir="$default_base/$user_repo"

    if [[ -d "$repo_dir" ]]; then
      local -a wt_completions
      while IFS= read -r branch; do
        [[ -n "$branch" ]] && wt_completions+=("$user_repo/$branch")
      done < <(git -C "$repo_dir" worktree list --porcelain 2>/dev/null | awk '
        /^branch / { b=$2; sub(".*/","",b); print b }
      ')
      if (( ${#wt_completions} )); then
        compadd -a wt_completions
        return
      fi
    fi
  fi

  # First argument: 'add' subcommand + all repo names
  # Use _describe for config entries (shows mapped path), compadd for the rest
  if (( ${#repo_descs} )); then
    _describe 'configured repos' repo_descs
  fi
  local -a extra
  extra=(add "${repo_names[@]}")
  compadd -a extra
}
compdef _ghcd ghcd

# zsh-autosuggestions (ghost-text history suggestions, accept with →)
for zsh_autosuggestions in \
  "/usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh" \
  "/usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh" \
  "$(brew --prefix 2>/dev/null)/share/zsh-autosuggestions/zsh-autosuggestions.zsh"; do
  if [[ -f "$zsh_autosuggestions" ]]; then
    source "$zsh_autosuggestions"
    break
  fi
done

# fzf key bindings (ctrl-r history dropdown, etc.)
for fzf_keybindings in \
  "$HOME/.nix-profile/share/fzf/key-bindings.zsh" \
  "/usr/share/fzf/key-bindings.zsh" \
  "/usr/share/doc/fzf/examples/key-bindings.zsh" \
  "$(brew --prefix 2>/dev/null)/opt/fzf/shell/key-bindings.zsh"; do
  if [[ -f "$fzf_keybindings" ]]; then
    source "$fzf_keybindings"
    break
  fi
done

# On Chainguard workstation, route URL opens back to the laptop via ssh reverse forward.
if [ -r /etc/os-release ] && grep -q '^ID=chainguard$' /etc/os-release; then
  export BROWSER="$HOME/.scripts/url-open"
fi

# The next line updates PATH for the Google Cloud SDK.
if [ -f '/home/nathan.fritz/.local/opt/google-cloud-sdk/path.zsh.inc' ]; then . '/home/nathan.fritz/.local/opt/google-cloud-sdk/path.zsh.inc'; fi

# The next line enables shell command completion for gcloud.
if [ -f '/home/nathan.fritz/.local/opt/google-cloud-sdk/completion.zsh.inc' ]; then . '/home/nathan.fritz/.local/opt/google-cloud-sdk/completion.zsh.inc'; fi
