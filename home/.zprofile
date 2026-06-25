if [[ -x /home/linuxbrew/.linuxbrew/bin/brew ]]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
fi

export PATH="$HOME/.local/bin:$HOME/.scripts:$HOME/go/bin:$PATH"
export EDITOR="/usr/bin/nvim"

alias ll="ls -al --color"
alias ls="ls --color"
