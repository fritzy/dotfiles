# Report interactive shell activity for FritzWorks. This file is installed by
# `fw hooks install` and is inert outside a FritzWorks shell terminal.
if [[ -n ${FRITZWORKS_ID:-${AI_WORKSTREAM_ID:-}} ]] && (( $+commands[fw] )); then
  autoload -Uz add-zsh-hook

  typeset -gi _fritzworks_hook_sequence=0
  export FRITZWORKS_HOOK_EMITTER="shell:$$:$RANDOM:$RANDOM"

  _fritzworks_shell_status() {
    (( ++_fritzworks_hook_sequence ))
    export FRITZWORKS_HOOK_SEQUENCE=$_fritzworks_hook_sequence
    command fw hook shell-status "$1" >/dev/null 2>&1
  }

  _fritzworks_shell_preexec() {
    _fritzworks_shell_status working
  }

  _fritzworks_shell_precmd() {
    _fritzworks_shell_status ready
  }

  add-zsh-hook preexec _fritzworks_shell_preexec
  add-zsh-hook precmd _fritzworks_shell_precmd
fi
