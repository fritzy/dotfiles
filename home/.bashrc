# Keep the persistent home directory authoritative on hosts whose passwd entry
# is rebuilt with /bin/bash. Restrict the handoff to interactive shells so
# `ssh host command`, scp, and Bash scripts continue to run under Bash.
if [[ $- == *i* && -z ${ZSH_VERSION:-} ]]; then
  if zsh_bin=$(command -v zsh 2>/dev/null); then
    export SHELL="$zsh_bin"
    exec "$zsh_bin" -l
  fi
fi

alias vi="nvim"
alias vim="nvim"

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init bash)"; fi
