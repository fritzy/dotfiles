# Switch to zsh if not already running
if zsh_bin=$(command -v zsh 2>/dev/null); then
    export SHELL="$zsh_bin"
    exec "$zsh_bin"
fi

alias vi="nvim"
alias vim="nvim"

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init bash)"; fi
