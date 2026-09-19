Unofficial packaging of [Claude Code](https://code.claude.com/docs/en/overview) @VERSION@ for jailbroken iOS.

## Download

| bootstrap | asset |
| --- | --- |
| rootless (Dopamine, palera1n rootless) | `wiki.qaq.claude_@VERSION@_iphoneos-arm64.deb` |
| RootHide Dopamine | `wiki.qaq.claude_@VERSION@_iphoneos-arm64e.deb` |

The architecture identifies the bootstrap layout, not the CPU. Check with `dpkg --print-architecture`.

Requires iOS @MIN_IOS_MAJOR@ or newer. Run `claude` in a terminal and use `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; browser login is opened with `uiopen`.

## Compatibility

- JavaScriptCore JIT is disabled.
- File-system events are stubbed; settings and external file changes are not hot-reloaded.
- Worker-backed hooks and cross-thread cancellation are not supported.
- `claude install`, `claude update`, and automatic updates are disabled; use the package manager.

The earlier rootless package was tested on-device through `--help`, `doctor`, DNS/TLS/HTTP, and the API error path. This update is build-verified; device testing of this version and RootHide validation remain pending.

The repository's packaging code is MIT. The bundled Claude Code executable remains subject to Anthropic's included license and legal terms. Verify downloads with `SHA256SUMS`.

**Packaging changes:** https://github.com/owngoal-dev/claude/commits/@TAG@

This revision updates the reviewed standalone binary layout and makes the
synchronous-wait compatibility patch tolerate minified variable renames. It
includes the pthread compatibility fix, daily validated upstream checks, and
native package details with a changelog generated from GitHub Releases.
