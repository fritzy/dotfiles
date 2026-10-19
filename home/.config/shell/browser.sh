if [ -r /etc/os-release ] && grep -q '^ID=chainguard$' /etc/os-release; then
  export BROWSER="$HOME/.scripts/url-open"
  export GH_BROWSER="$BROWSER"
  export GITSIGN_URL_OPENER="$BROWSER {{.URL}}"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
  esac
fi
