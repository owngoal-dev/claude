#!/bin/sh

_claude_prefix="@PREFIX@"

case "${1:-}" in
install | update | upgrade)
    echo "claude is package-managed on iOS; update it with your jailbreak package manager" >&2
    exit 1
    ;;
esac

DISABLE_AUTOUPDATER=1
BUN_JSC_useJIT=false
export DISABLE_AUTOUPDATER BUN_JSC_useJIT

if [ -n "$_claude_prefix" ]; then
    PATH="@PREFIX@/usr/bin:@PREFIX@/bin:$PATH"
    if [ -z "${SHELL:-}" ] || [ ! -x "$SHELL" ]; then
        for _claude_shell in "@PREFIX@/usr/bin/zsh" "@PREFIX@/usr/bin/bash" "@PREFIX@/usr/bin/sh"; do
            if [ -x "$_claude_shell" ]; then SHELL="$_claude_shell"; break; fi
        done
    fi
else
    _claude_usr_bin="$(jbroot /usr/bin)" || exit $?
    _claude_bin="$(jbroot /bin)" || exit $?
    PATH="$_claude_usr_bin:$_claude_bin:$PATH"
    if [ -n "${SHELL:-}" ]; then SHELL="$(jbroot "$SHELL")" || exit $?; fi
    unset _claude_usr_bin _claude_bin
fi
export PATH SHELL
unset _claude_shell

if command -v uiopen >/dev/null 2>&1; then
    BROWSER="$(command -v uiopen)"
    export BROWSER
fi

exec @PREFIX@/usr/libexec/claude/claude "$@"
