# Switch to zsh if not already running
if zsh_bin=$(command -v zsh 2>/dev/null); then
    export SHELL="$zsh_bin"
    exec "$zsh_bin"
fi

alias vi="nvim"
alias vim="nvim"
