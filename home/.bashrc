# Switch to zsh if not already running
if [ -x /bin/zsh ]; then
    export SHELL=/bin/zsh
    exec /bin/zsh
fi
