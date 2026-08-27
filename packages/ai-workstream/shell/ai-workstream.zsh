# Report interactive shell activity for FritzWorks. This file is installed by
# `ws hooks install` and is inert outside an ai-workstream shell pane.
if [[ -n ${AI_WORKSTREAM_ID:-} ]] && (( $+commands[ws] )); then
  autoload -Uz add-zsh-hook

  _ai_workstream_shell_status() {
    command ws hook shell-status "$1" >/dev/null 2>&1
  }

  _ai_workstream_shell_preexec() {
    _ai_workstream_shell_status working
  }

  _ai_workstream_shell_precmd() {
    _ai_workstream_shell_status ready
  }

  add-zsh-hook preexec _ai_workstream_shell_preexec
  add-zsh-hook precmd _ai_workstream_shell_precmd
fi
